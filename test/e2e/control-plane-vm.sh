#!/bin/bash
# e2e.yml's burst, on Azure: what the control plane VM went through, run on
# it through `az vm run-command`, which keeps its output's last 4 KiB only.
# Pods that restarted and why the last one ended, OOM kills, memory now and
# its pressure, CPU steal since boot, and cgroup peak memory since boot: all
# pods', K3s's and the API pod's.
k() { k3s kubectl "$@"; }
echo 'Restarted pods (namespace, name, restarts, last termination):'
k get pods -A --no-headers -o custom-columns='NS:.metadata.namespace,N:.metadata.name,R:.status.containerStatuses[*].restartCount,L:.status.containerStatuses[*].lastState.terminated.reason' |
  awk '$3 !~ /^(0,?)+$/'
echo "OOM kills: $(dmesg | grep -ci 'killed process')"
grep -E '^(MemTotal|MemAvailable):' /proc/meminfo
echo "Memory pressure: $(tr '\n' ' ' </proc/pressure/memory)"
echo "CPU steal since boot: $(awk '/^cpu /{print $9 / 100}' /proc/stat) s of $(cut -d' ' -f1 /proc/uptime) s up"
peak() { [ -f "$1/memory.peak" ] && echo "$2 peak: $(($(cat "$1/memory.peak") / 1048576)) MiB"; }
peak /sys/fs/cgroup/kubepods 'All pods'
peak /sys/fs/cgroup/kubepods.slice 'All pods'
peak /sys/fs/cgroup/system.slice/k3s.service K3s
uid=$(k get pods -A -o jsonpath='{range .items[*]}{.metadata.name} {.metadata.uid}{"\n"}{end}' |
  awk '/^anycloud-api-/{print $2; exit}')
for dir in $(find /sys/fs/cgroup/kubepods* -maxdepth 3 -type d \( -name "*${uid}*" -o -name "*${uid//-/_}*" \) 2>/dev/null); do
  peak "$dir" 'API pod'
done
k top pods -A --no-headers 2>/dev/null | sort -k4 -h | tail -5
