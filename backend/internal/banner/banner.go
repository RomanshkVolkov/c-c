// Package banner prints a colored ANSI Shadow startup splash for the cac
// backend. Purely decorative — structured logs continue via the logger. It is
// the house signature: every guz-studio service boots with this wordmark.
package banner

import (
	"fmt"
	"strings"
	"time"
)

// Brand palette as 24-bit truecolor so the splash matches the intended hex
// (not a 256-color approximation). Terminals without truecolor degrade
// gracefully to the nearest color.
const (
	blue   = "\033[38;2;59;130;246m" // acento marca — control plane blue
	green  = "\033[38;2;31;184;116m" // listening OK
	cyan   = "\033[38;2;94;211;235m" // info bullets
	yellow = "\033[38;2;255;210;26m" // values
	gray   = "\033[90m"
	bold   = "\033[1m"
	reset  = "\033[0m"
)

// Print renders the splash with the active env and port.
func Print(env, port string) {
	lines := []string{
		"",
		blue + "   ██████╗    █████╗    ██████╗" + reset,
		blue + "  ██╔════╝   ██╔══██╗  ██╔════╝" + reset,
		blue + "  ██║        ███████║  ██║     " + reset,
		blue + "  ██║        ██╔══██║  ██║     " + reset,
		blue + "  ╚██████╗   ██║  ██║  ╚██████╗" + reset,
		blue + "   ╚═════╝   ╚═╝  ╚═╝   ╚═════╝" + reset,
		gray + "         COMMAND & CONTROL · API" + reset,
		"",
		fmt.Sprintf("    %s[+]%s env       %s%s%s", cyan, reset, yellow, env, reset),
		fmt.Sprintf("    %s[+]%s port      %s%s%s", cyan, reset, yellow, port, reset),
		fmt.Sprintf("    %s[+]%s health    %shttp://localhost:%s/health%s", cyan, reset, gray, port, reset),
		fmt.Sprintf("    %s[+]%s booted    %s%s%s", cyan, reset, gray, time.Now().Format("2006-01-02 15:04:05"), reset),
		"",
		fmt.Sprintf("    %s>>%s listening on %s:%s%s", green, reset, bold, port, reset),
		"",
	}
	fmt.Println(strings.Join(lines, "\n"))
}
