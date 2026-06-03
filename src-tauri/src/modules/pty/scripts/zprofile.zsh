# artex-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _artex_user_zdotdir="${ARTEX_USER_ZDOTDIR:-$HOME}"
  [ -f "$_artex_user_zdotdir/.zprofile" ] && source "$_artex_user_zdotdir/.zprofile"
  unset _artex_user_zdotdir
}
:
