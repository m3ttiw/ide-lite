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
| `C-x C-f` | Apri file (ricerca fuzzy, o per schema con `*` e `?`) |
| `C-x C-s` | Salva |
| `C-x b` / `C-x k` | Cambia / chiudi buffer |
| `C-x o` | Pannello successivo |
| `C-x g` / `C-x m` | Cronologia / modifiche |
| `C-x w` | Cerca worktree |
| `C-x d` | Apri cartella |
| `M-x` | Tutti i comandi |
| `C-h` | Tutte le scorciatoie |
| `C-g` | Annulla |

In Apri file una ricerca con `*` o `?` è uno schema sul nome intero del file: `communications*.ts` trova i file il cui nome inizia per "communications" e finisce per ".ts". `*` non attraversa le cartelle, `**` sì; con una `/` lo schema vale per il percorso (`api/*.ts`, `src/**/*.test.ts`) e una `/` iniziale lo lega alla radice.

## Sviluppo

Servono Node, Rust (stable), git 2.36 o successivo e WebView2 (già presente in Windows 11).

```bash
npm install
npx tauri dev -- -- C:/percorso/di/un/repo   # app con ricarica a caldo, aperta su quella cartella
npm run dev                                  # solo interfaccia nel browser, con dati finti
npx tauri build --no-bundle                  # eseguibile in src-tauri/target/release
```

Senza argomento l'app riapre l'ultima cartella usata; al primo avvio, o se quella non esiste più, apre la cartella home dell'utente.

Test:

```bash
npm test                       # interfaccia: grafo, ricerca fuzzy, tasti, date
cargo test --manifest-path src-tauri/Cargo.toml   # backend, su repository git creati al volo
```

## Rilasci e aggiornamenti

- Ogni push su `main` passa da semantic-release (`.releaserc`): `feat` e breaking change aprono una minor, `fix`/`perf`/`refactor`/`style` una patch, gli altri tipi nessun rilascio. Finché siamo in `0.x`, `1.0.0` resta riservata.
- La versione vive solo in `package.json` (`tauri.conf.json` la legge da lì). Non creare tag a mano: il commit `chore(release): X.Y.Z` e il tag `vX.Y.Z` li fa `versioning.yml`, che poi avvia `release.yml`.
- `release.yml` esegue i test, costruisce l'installer NSIS firmato per l'updater e lo pubblica con `.sig` e `latest.json` in una release creata come bozza e resa pubblica solo se tutto è riuscito.
- L'app installata controlla `releases/latest/download/latest.json` 15 secondi dopo l'avvio e poi ogni 6 ore (si disattiva da Impostazioni, `C-,`); scarica e installa solo su comando ("Aggiorna ide-lite" da `M-x`, o dalle Impostazioni), poi si riavvia. Le build di sviluppo non controllano nulla.
- Secret richiesti: `TAURI_SIGNING_PRIVATE_KEY` (contenuto della chiave privata) e, solo se la chiave ha una password, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (GitHub non accetta secret vuoti; se manca vale stringa vuota).

## Struttura

- `src/api/types.ts` — contratto tra interfaccia e backend: le 15 chiamate e i loro tipi.
- `src-tauri/src/` — comandi Rust; git è usato tramite l'eseguibile di sistema.
- `src/` — interfaccia: `core/` (comandi e tasti), `state/`, `components/`, `editor/` (CodeMirror, caricato dopo il primo disegno).
- `public/icon.svg` — il logo ("IL", ide lite). Le icone in `src-tauri/icons` si rigenerano da lì con `npx tauri icon public/icon.svg` (poi si tengono solo i file già presenti, niente `android/` e `ios/`).
