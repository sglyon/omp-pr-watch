#!/usr/bin/env bash
# Stand-in for `gh event listen`, driven by FAKE_GH_MODE. Ignores its argv (the real
# listener.ts always passes `event listen --resource ... --follow --event ...`).
set -u

mode="${FAKE_GH_MODE:-events}"

case "$mode" in
	events)
		echo "stream attached: pull_request events for octo-org/widgets#1" >&2
		echo '{"type":"com.github.pull_request.state.changed.v1","id":"evt-1"}'
		echo '{"type":"com.github.pull_request.head.changed.v1","id":"evt-2"}'
		sleep 30
		;;
	forbidden)
		echo "event subscriptions are in preview and not enabled for this account: HTTP 403: Event subscriptions are not enabled for this account (https://api.github.com/event-subscriptions)" >&2
		exit 1
		;;
	enterprise)
		echo "gh event listen is only available for pull requests on github.com" >&2
		exit 1
		;;
	exit)
		exit 1
		;;
	*)
		exit 1
		;;
esac
