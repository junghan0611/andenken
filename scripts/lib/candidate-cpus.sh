# candidate_cpu_list [N] — the first N (default 8) CPUs of this process's
# allowed set, comma-separated. Used by `./run.sh candidate:sessions:build`
# to pin the build with taskset; every child inherits the mask.
candidate_cpu_list() {
	local max="${1:-8}" list part a b i
	local -a parts cpus=()
	list=$(awk '/^Cpus_allowed_list:/{print $2}' /proc/self/status) || return 1
	[ -n "$list" ] || return 1
	IFS=, read -ra parts <<<"$list"
	for part in "${parts[@]}"; do
		a=${part%-*}
		b=${part#*-}
		for ((i = a; i <= b; i++)); do
			cpus+=("$i")
			[ "${#cpus[@]}" -ge "$max" ] && break 2
		done
	done
	[ "${#cpus[@]}" -gt 0 ] || return 1
	(
		IFS=,
		echo "${cpus[*]}"
	)
}
