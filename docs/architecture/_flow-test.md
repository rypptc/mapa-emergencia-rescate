# Flowchart bisect — tell me which render

## F1 — minimal

```mermaid
flowchart TB
    a --> b
```

## F2 — quoted labels + parens

```mermaid
flowchart TB
    a["Cloudflare (proxied)"] --> b["LB"]
```

## F3 — subgraph with quoted title

```mermaid
flowchart TB
    subgraph net["Red privada"]
        x["postgres"]
    end
    a --> x
```

## F4 — subgraph plain title (no quotes/brackets)

```mermaid
flowchart TB
    subgraph net [Red privada]
        x["postgres"]
    end
    a --> x
```

## F5 — middle dot and br in label

```mermaid
flowchart TB
    m["mapa-master<br/>10.0.1.5 · control plane"]
    m --> n["node"]
```

## F6 — dotted link with label

```mermaid
flowchart TB
    a -.assets.-> b
```
