# arterm-shell-integration (zprofile)
#
# See zshenv.zsh for the rationale on the trailing `:`.
{
  _arterm_user_zdotdir="${ARTERM_USER_ZDOTDIR:-$HOME}"
  [ -f "$_arterm_user_zdotdir/.zprofile" ] && source "$_arterm_user_zdotdir/.zprofile"
  unset _arterm_user_zdotdir
}
:
