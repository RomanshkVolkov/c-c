# @g-studio/report-widget

Embeddable bug-report widget for the **cac** tracker. Installs passive telemetry
breadcrumbs (JS errors, `console.error/warn`, failed requests, navigation) on
init and attaches them — plus page context and screenshots — to reports it POSTs
to the public ingest endpoint. Payment/auth hosts are hard-denylisted; the
`fetch`/XHR patch is pure passthrough in `try/catch`, so the widget can never
cause a failed payment or login.

## Install

```bash
bun add @g-studio/report-widget    # or npm/pnpm/yarn
```

## Option 1 — React / Next.js

```tsx
"use client";
import { ReportWidget } from "@g-studio/report-widget/react";

export function BugReporter() {
  return (
    <ReportWidget
      projectKey={process.env.NEXT_PUBLIC_REPORT_KEY!}
      endpoint="https://cac.guz-studio.dev"
      snapshot={{ localStorage: ["feature-flags", "app-state"] }}
      context={() => ({ appVersion: process.env.NEXT_PUBLIC_VERSION })}
      theme={{ color: "#2563eb", position: "bottom-right" }}
    />
  );
}
```

Render it once in a client component (e.g. the root layout).

## Option 2 — Headless (any framework)

Drive your own UI; the widget just collects + submits.

```ts
import { createReporter } from "@g-studio/report-widget";

const reporter = createReporter({ projectKey: "pk_…", endpoint: "https://cac.guz-studio.dev" });
await reporter.submit({ title: "Checkout broke", description: "…", images: [file] });
// reporter.telemetry() → current breadcrumbs (for a "what will be sent" preview)
// reporter.destroy()   → stop collecting, restore patched globals
```

## Option 3 — Script tag (no build step)

```html
<script
  src="https://cac.guz-studio.dev/widget.js"
  data-project-key="pk_…"
  data-endpoint="https://cac.guz-studio.dev"
  data-color="#2563eb"
  data-position="bottom-right"
></script>
```

Single self-contained file (~10 KB), no peer deps. Auto-mounts a launcher. Only
requirement: add the ingest origin to your site's `connect-src` CSP.

## Config (`WidgetConfig`)

| Field | Type | Notes |
|---|---|---|
| `projectKey` | `string` | **required** — public write-only ingest key (`pk_…`) |
| `endpoint` | `string` | ingest base URL (default `https://cac.guz-studio.dev`) |
| `context` | `() => object` | curated data attached to every report |
| `snapshot` | `{ localStorage?: string[]; cookies?: boolean }` | opt-in allowlist (never a wholesale dump) |
| `captureBodies` | `string[]` | path globs whose **failed** request bodies are captured (payment/auth hosts always excluded) |
| `scrubFields` | `string[]` | extra body field names to redact (merged with defaults) |
| `theme` | `{ color?; position? }` | launcher styling |

Telemetry is scrubbed in the browser before sending; the server re-redacts and
encrypts it at rest (AES-GCM) with a retention TTL.
