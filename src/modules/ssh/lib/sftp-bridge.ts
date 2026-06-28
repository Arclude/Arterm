import { invoke } from "@tauri-apps/api/core";

export type SftpEntry = {
  name: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
};

export const sftpList = (connId: number, path: string) =>
  invoke<SftpEntry[]>("ssh_sftp_list", { connId, path });

export const sftpRead = (connId: number, path: string) =>
  invoke<string>("ssh_sftp_read", { connId, path });

export const sftpWrite = (connId: number, path: string, contents: string) =>
  invoke<void>("ssh_sftp_write", { connId, path, contents });

export const sftpDownload = (connId: number, remote: string, local: string) =>
  invoke<void>("ssh_sftp_download", { connId, remote, local });

export type SftpDownloadSummary = { downloaded: number; failed: number };

export const sftpDownloadDir = (
  connId: number,
  opId: number,
  remote: string,
  local: string,
) =>
  invoke<SftpDownloadSummary>("ssh_sftp_download_dir", {
    connId,
    opId,
    remote,
    local,
  });

export const sftpUpload = (connId: number, local: string, remote: string) =>
  invoke<void>("ssh_sftp_upload", { connId, local, remote });

export const sftpMkdir = (connId: number, path: string) =>
  invoke<void>("ssh_sftp_mkdir", { connId, path });

export const sftpRename = (connId: number, from: string, to: string) =>
  invoke<void>("ssh_sftp_rename", { connId, from, to });

export const sftpDelete = (connId: number, path: string, isDir: boolean) =>
  invoke<void>("ssh_sftp_delete", { connId, path, isDir });

/** Join a POSIX directory and a child name (remote paths are always POSIX). */
export function joinRemote(dir: string, name: string): string {
  if (dir === "" || dir === ".") return name;
  return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

/** Parent of a POSIX path, or "." at the root. */
export function parentRemote(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : ".";
  return trimmed.slice(0, idx);
}

/** Last path segment of a local (possibly Windows) path. */
export function localBaseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}
