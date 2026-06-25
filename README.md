# Amore Paraíso — Deck Publishing Repo

This repository hosts the public experience presentations for Amore Paraíso couples.
It is connected to **Cloudflare Pages**, which automatically publishes any change pushed here.

**Live at:** https://experiences.amoreparaiso.com

## How it works

- Every couple gets a folder: `/<couple-names>/index.html`
- That folder becomes a live URL: `https://experiences.amoreparaiso.com/<couple-names>`
- Pushing to the `main` branch auto-deploys in ~20 seconds.
- The root `index.html` is a minimal branded placeholder (not indexed by search engines).

## Structure

```
/
├── index.html              ← root placeholder
├── gabrielle-trevor/
│   └── index.html          ← https://experiences.amoreparaiso.com/gabrielle-trevor
└── <next-couple>/
    └── index.html
```

## Publishing

Decks are published by Claude (Cowork). Just say e.g. *"publish the Smith deck"*.
The full workflow is documented in the main project at
`_Company/SOPs/Deck_Publishing_SOP.md`.

Each deck is a single self-contained HTML file (images embedded), so there is
no build step and nothing external to break.
