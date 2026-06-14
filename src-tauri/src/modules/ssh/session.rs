//! russh-backed SSH client: connection, authentication and interactive shell
//! channels. A shell channel is driven by its own async task that bridges the
//! remote byte stream onto the same Tauri `Channel<Response>` pipeline the local
//! PTY uses, so the frontend cannot tell a remote session from a local one.

use std::sync::Arc;

use russh::client::{self, Handle};
use russh::keys::*;
use russh::ChannelMsg;
use serde::Deserialize;
use tauri::ipc::{Channel as IpcChannel, Response};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};

/// How to authenticate against the server. Secrets (password / passphrase) are
/// resolved from the platform keychain on the frontend and passed in here; the
/// private key itself is read from disk on this side.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AuthConfig {
    Password { password: String },
    Key {
        path: String,
        passphrase: Option<String>,
    },
    Agent,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthConfig,
    /// OpenSSH-format public key line trusted on a previous connection (TOFU).
    /// `None` means this host has never been seen, so the user is prompted.
    #[serde(default)]
    pub known_host_key: Option<String>,
}

/// Commands sent from Tauri command handlers to a live shell task.
pub enum ShellCmd {
    Data(Vec<u8>),
    Resize(u16, u16),
    Close,
}

pub struct Client {
    app: AppHandle,
    conn_id: u32,
    expected_host_key: Option<String>,
    /// One-shot the host-key prompt awaits when the host is unknown. Taken on
    /// first (and only) `check_server_key` call.
    decision: Mutex<Option<oneshot::Receiver<bool>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let presented = server_public_key.to_openssh().unwrap_or_default();
        let fingerprint = server_public_key
            .fingerprint(Default::default())
            .to_string();

        match &self.expected_host_key {
            // Known and unchanged — trust silently.
            Some(known) if known == &presented => Ok(true),
            // Known but changed — refuse and warn. The user must delete the
            // saved profile key to re-trust (prevents silent MITM acceptance).
            Some(_) => {
                let _ = self.app.emit(
                    "ssh-hostkey-mismatch",
                    serde_json::json!({
                        "connId": self.conn_id,
                        "fingerprint": fingerprint,
                        "key": presented,
                    }),
                );
                Ok(false)
            }
            // First time seeing this host — ask the user (TOFU). The frontend
            // persists the accepted key into the profile.
            None => {
                let _ = self.app.emit(
                    "ssh-hostkey-unknown",
                    serde_json::json!({
                        "connId": self.conn_id,
                        "fingerprint": fingerprint,
                        "key": presented,
                    }),
                );
                let rx = self.decision.lock().await.take();
                match rx {
                    Some(rx) => Ok(rx.await.unwrap_or(false)),
                    None => Ok(false),
                }
            }
        }
    }
}

/// Establish a connection and authenticate. Returns the live session handle on
/// success. `decision_rx` is fulfilled by `ssh_known_host_decision` when the
/// host key is unknown.
pub async fn connect(
    app: AppHandle,
    conn_id: u32,
    cfg: ConnectConfig,
    decision_rx: oneshot::Receiver<bool>,
) -> Result<Handle<Client>, String> {
    let config = Arc::new(client::Config::default());
    let handler = Client {
        app,
        conn_id,
        expected_host_key: cfg.known_host_key.clone(),
        decision: Mutex::new(Some(decision_rx)),
    };

    let mut handle = client::connect(config, (cfg.host.as_str(), cfg.port), handler)
        .await
        .map_err(|e| format!("connect failed: {e}"))?;

    let user = cfg.username.clone();
    let authed = match cfg.auth {
        AuthConfig::Password { password } => {
            let res = handle
                .authenticate_password(user, password)
                .await
                .map_err(|e| format!("password auth error: {e}"))?;
            matches!(res, client::AuthResult::Success)
        }
        AuthConfig::Key { path, passphrase } => {
            let key = load_secret_key(&path, passphrase.as_deref())
                .map_err(|e| format!("key load failed ({path}): {e}"))?;
            let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
            let res = handle
                .authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await
                .map_err(|e| format!("key auth error: {e}"))?;
            matches!(res, client::AuthResult::Success)
        }
        AuthConfig::Agent => authenticate_agent(&mut handle, &user).await?,
    };

    if !authed {
        return Err("authentication failed".into());
    }
    Ok(handle)
}

/// Connect to the platform's ssh-agent and try its identities. Unix uses
/// `SSH_AUTH_SOCK`; Windows prefers the OpenSSH agent named pipe and falls back
/// to Pageant.
async fn authenticate_agent(handle: &mut Handle<Client>, user: &str) -> Result<bool, String> {
    #[cfg(unix)]
    {
        let agent = agent::client::AgentClient::connect_env()
            .await
            .map_err(|e| format!("ssh-agent connect failed: {e}"))?;
        try_agent_auth(handle, user, agent).await
    }
    #[cfg(windows)]
    {
        match agent::client::AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await
        {
            Ok(agent) => try_agent_auth(handle, user, agent).await,
            Err(_) => {
                let agent = agent::client::AgentClient::connect_pageant().await;
                try_agent_auth(handle, user, agent).await
            }
        }
    }
}

/// Try every identity an agent offers until one authenticates.
async fn try_agent_auth<S>(
    handle: &mut Handle<Client>,
    user: &str,
    mut agent: agent::client::AgentClient<S>,
) -> Result<bool, String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| format!("ssh-agent identities failed: {e}"))?;
    if identities.is_empty() {
        return Err("ssh-agent has no identities".into());
    }
    for key in identities {
        let hash = handle.best_supported_rsa_hash().await.ok().flatten().flatten();
        if let Ok(client::AuthResult::Success) = handle
            .authenticate_publickey_with(user, key, hash, &mut agent)
            .await
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Open an interactive shell channel and spawn its driver task. Returns the
/// sender used to feed keystrokes / resizes / close into that task.
pub async fn open_shell(
    handle: &Handle<Client>,
    cols: u16,
    rows: u16,
    on_data: IpcChannel<Response>,
    on_exit: IpcChannel<i32>,
) -> Result<mpsc::UnboundedSender<ShellCmd>, String> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| format!("open session failed: {e}"))?;
    channel
        .request_pty(false, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
        .await
        .map_err(|e| format!("request_pty failed: {e}"))?;
    channel
        .request_shell(true)
        .await
        .map_err(|e| format!("request_shell failed: {e}"))?;

    let (tx, mut rx) = mpsc::unbounded_channel::<ShellCmd>();

    tauri::async_runtime::spawn(async move {
        let mut channel = channel;
        let mut exit_code: i32 = 0;
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => {
                        if on_data.send(Response::new(data.to_vec())).is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        if on_data.send(Response::new(data.to_vec())).is_err() {
                            break;
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit_code = exit_status as i32;
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(ShellCmd::Data(bytes)) => {
                        if channel.data(&bytes[..]).await.is_err() {
                            break;
                        }
                    }
                    Some(ShellCmd::Resize(c, r)) => {
                        let _ = channel.window_change(c as u32, r as u32, 0, 0).await;
                    }
                    Some(ShellCmd::Close) | None => {
                        let _ = channel.eof().await;
                        break;
                    }
                },
            }
        }
        let _ = on_exit.send(exit_code);
    });

    Ok(tx)
}
