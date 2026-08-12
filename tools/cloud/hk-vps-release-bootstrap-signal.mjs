export const REMOTE_SIGNAL_RECOVERY_GRACE_SECONDS = 75 * 60;

export function releaseBootstrapSignalScript() {
  return `read_process_record() {
  local process_pid="$1" process_stat="" process_tail="" process_state="" process_start=""
  local -a process_fields=()
  case "\${process_pid}" in (''|*[!0-9]*) return 1 ;; esac
  IFS= read -r process_stat 2>/dev/null <"/proc/\${process_pid}/stat" || return 1
  process_tail="\${process_stat##*) }"
  [ "\${process_tail}" != "\${process_stat}" ] || return 1
  IFS=' ' read -r -a process_fields <<<"\${process_tail}" || return 1
  [ "\${#process_fields[@]}" -ge 20 ] || return 1
  process_state="\${process_fields[0]}"
  process_start="\${process_fields[19]}"
  case "\${process_state}" in (''|*[!A-Za-z]*) return 1 ;; esac
  case "\${process_start}" in (''|*[!0-9]*) return 1 ;; esac
  printf '%s:%s %s\\n' "\${process_pid}" "\${process_start}" "\${process_state}"
}
read_process_identity() {
  local process_record=""
  process_record="$(read_process_record "$1")" || return 1
  printf '%s\\n' "\${process_record%% *}"
}
process_is_active_identity() {
  local process_record="" process_identity="" process_state=""
  [ -n "$2" ] || return 1
  process_record="$(read_process_record "$1")" || return 1
  process_identity="\${process_record%% *}"
  process_state="\${process_record##* }"
  [ "\${process_identity}" = "$2" ] && [ "\${process_state}" != Z ] &&
    [ "\${process_state}" != X ] && [ "\${process_state}" != x ]
}
stop_reader() {
  local reader_pid="$1" reader_identity="$2"
  if [ -n "\${reader_pid}" ]; then
    if process_is_active_identity "\${reader_pid}" "\${reader_identity}"; then
      kill -TERM "\${reader_pid}" >/dev/null 2>&1 || true
    fi
    wait "\${reader_pid}" >/dev/null 2>&1 || true
  fi
}
watch_session_parent() {
  trap - EXIT HUP INT TERM
  IFS= read -r watchdog_ready
  [ "\${watchdog_ready}" = go ] || exit 0
  while process_is_active_identity "\${session_parent_pid}" "\${session_parent_identity}"; do
    /bin/sleep 1 >/dev/null 2>&1 || break
  done
  if process_is_active_identity "\${bootstrap_pid}" "\${bootstrap_identity}"; then
    kill -HUP "\${bootstrap_pid}" >/dev/null 2>&1 || true
  fi
}
stop_session_watchdog() {
  if [ -n "\${watchdog_pid}" ]; then
    if process_is_active_identity "\${watchdog_pid}" "\${watchdog_identity}"; then
      kill -TERM "\${watchdog_pid}" >/dev/null 2>&1 || true
    fi
    wait "\${watchdog_pid}" >/dev/null 2>&1 || true
    watchdog_pid=""
    watchdog_identity=""
  fi
}
defer_release_signals() {
  trap 'signal_pending=HUP' HUP
  trap 'signal_pending=INT' INT
  trap 'signal_pending=TERM' TERM
}
handle_release_signals() {
  trap 'on_signal HUP' HUP
  trap 'on_signal INT' INT
  trap 'on_signal TERM' TERM
}
start_session_watchdog() {
  bootstrap_pid="$$"
  bootstrap_identity="$(read_process_identity "\${bootstrap_pid}")" ||
    bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
  session_parent_pid="$PPID"
  session_parent_identity="$(read_process_identity "\${session_parent_pid}")" ||
    bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
  defer_release_signals
  watchdog_pipe="\${capture_dir}/watchdog.pipe"
  mkfifo -- "\${watchdog_pipe}" 2>/dev/null ||
    bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
  watch_session_parent <"\${watchdog_pipe}" >/dev/null 2>&1 &
  watchdog_pid=$!
  if ! watchdog_identity="$(read_process_identity "\${watchdog_pid}")"; then
    printf 'stop\\n' >"\${watchdog_pipe}" 2>/dev/null || true
    wait "\${watchdog_pid}" >/dev/null 2>&1 || true
    watchdog_pid=""
  else
    printf 'go\\n' >"\${watchdog_pipe}" 2>/dev/null ||
      bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
  fi
  handle_release_signals
  [ -n "\${watchdog_pid}" ] || bootstrap_fail CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
  if [ -n "\${signal_pending}" ]; then
    on_signal "\${signal_pending}"
  fi
}
on_signal() {
  received_signal="$1"
  trap '' HUP INT TERM
  bootstrap_error=CLOUD_RELEASE_BOOTSTRAP_REMOTE_ENTRY_FAILED
  stop_session_watchdog
  if [ -n "\${remote_pid}" ]; then
    if process_is_active_identity "\${remote_pid}" "\${remote_identity}"; then
      kill -s "\${received_signal}" "\${remote_pid}" >/dev/null 2>&1 || true
      remaining=${REMOTE_SIGNAL_RECOVERY_GRACE_SECONDS}
      while [ "\${remaining}" -gt 0 ] &&
        process_is_active_identity "\${remote_pid}" "\${remote_identity}"; do
        /bin/sleep 1 >/dev/null 2>&1 || break
        remaining=$((remaining - 1))
      done
      if [ "\${remaining}" -eq 0 ] &&
        process_is_active_identity "\${remote_pid}" "\${remote_identity}"; then
        kill -KILL "\${remote_pid}" >/dev/null 2>&1 || true
      fi
    fi
    wait "\${remote_pid}" >/dev/null 2>&1 || true
    remote_pid=""
    remote_identity=""
  fi
  stop_reader "\${stdout_reader}" "\${stdout_reader_identity}"
  stop_reader "\${stderr_reader}" "\${stderr_reader_identity}"
  stdout_reader=""
  stdout_reader_identity=""
  stderr_reader=""
  stderr_reader_identity=""
  if capture_remote_code && [ "\${remote_code}" = CLOUD_RELEASE_RECOVERY_REQUIRED ]; then
    bootstrap_error="\${remote_code}"
  fi
  exit 74
}`;
}
