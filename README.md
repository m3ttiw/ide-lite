# ide-lite

Un IDE volutamente piccolo: albero dei file, cronologia git con diff per commit, worktree con ricerca, scorciatoie in stile Emacs mostrate a schermo come suggerimenti.

Tauri 2 (backend Rust) + Solid + CodeMirror 6. L'eseguibile pesa circa 5 MB.

## Funzioni

- **File**: albero caricato una cartella alla volta, badge git sui file modificati, file ignorati in grigio.
- **Editor**: schede, salvataggio che conserva il fine riga del file, sintassi colorata (Rust, JS/TS, JSON, Markdown, HTML, CSS, Python, TOML, YAML).
- **Cronologia**: grafo dei commit con rami e merge, file cambiati e diff per ogni commit.
- **Modifiche**: file in stage, non in stage e non tracciati, ognuno con il suo diff.
- **Worktree**: selettore con ricerca per branch o cartella, cambio rapido, creazione di un nuovo worktree.
- **Suggerimenti**: la barra in basso mostra le scorciatoie valide nel pannello attivo; dopo un prefisso come `C-x` elenca tutte le continuazioni.

Non ci sono ancora la ricerca nel progetto e l'aggiornamento automatico quando i file cambiano su disco (l'albero si aggiorna al ritorno sulla finestra e dopo un salvataggio).

## Scorciatoie principali

Notazione Emacs: `C-` è Ctrl, `M-` è Alt. La modalità "Standard" (Ctrl+P, Ctrl+S…) si attiva dalla barra di stato o da `M-x`.

| Tasti | Azione |
|---|---|
| `C-x C-f` | Apri file (ricerca fuzzy) |
| `C-x C-s` | Salva |
| `C-x b` / `C-x k` | Cambia / chiudi buffer |
| `C-x o` | Pannello successivo |
| `C-x g` / `C-x m` | Cronologia / modifiche |
| `C-x w` | Cerca worktree |
| `C-x d` | Apri cartella |
| `M-x` | Tutti i comandi |
| `C-h` | Tutte le scorciatoie |
| `C-g` | Annulla |

## Sviluppo

Servono Node, Rust (stable), git 2.36 o successivo e WebView2 (già presente in Windows 11).

```bash
npm install
npx tauri dev -- -- C:/percorso/di/un/repo   # app con ricarica a caldo, aperta su quella cartella
npm run dev                                  # solo interfaccia nel browser, con dati finti
npx tauri build --no-bundle                  # eseguibile in src-tauri/target/release
```

Senza argomento l'app apre la cartella da cui viene lanciata.

Test:

```bash
npm test                       # interfaccia: grafo, ricerca fuzzy, tasti, date
cargo test --manifest-path src-tauri/Cargo.toml   # backend, su repository git creati al volo
```

## Struttura

- `src/api/types.ts` — contratto tra interfaccia e backend: le 15 chiamate e i loro tipi.
- `src-tauri/src/` — comandi Rust; git è usato tramite l'eseguibile di sistema.
- `src/` — interfaccia: `core/` (comandi e tasti), `state/`, `components/`, `editor/` (CodeMirror, caricato dopo il primo disegno).
