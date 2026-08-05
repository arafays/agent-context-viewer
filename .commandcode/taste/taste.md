# Taste

## Tooling
- Points the agent at specific libraries rather than letting it pick (e.g. directed the use of `fff` / dmtrKovalenko/fff for fuzzy search). Confidence: 0.7

## Design & performance tradeoffs
- Prefers search results to deep-link to the matched location (jump to the matching turn in the transcript) rather than just opening the item at the top. Confidence: 0.6
- Prefers terminal UIs to derive colors from the actual terminal palette (OSC queries via the framework) rather than hardcoded ANSI color names, enforcing minimum WCAG contrast with a fallback to default fg — their dark theme makes fixed named colors like `blue` (#0000ff) unreadable. Confidence: 0.5
- Prefers pragmatic indexing scope over completeness when cost is high — e.g. index user+assistant text and deliberately exclude bulky, low-signal data (like tool output in a 5GB DB) to keep indexing fast. Confidence: 0.6
