# werkstatt

Werkzeuge für Softwareentwicklung, bei der Coding-Agents den Code schreiben.
Menschen spezifizieren und geben frei, Agents setzen um, automatische Prüfungen
und ein unabhängiges Review sichern die Qualität.

## Werkzeuge

| Werkzeug                       | Art                    | Stand         |
|--------------------------------|------------------------|---------------|
| `project-init`                 | Skill                  | erste Version |
| `spec-interview`               | Skill                  | erste Version |
| `derive-tests`                 | Skill                  | erste Version |
| Akzeptanztests sperren         | Hooks                  | erste Version |
| `reviewer`                     | Agent                  | erste Version |
| Orchestrator (`werkstatt run`) | Agent SDK (TypeScript) | erste Version |
| Metriken-Auswertung            | –                      | geplant       |

## Einrichten

werkstatt ist ein Claude-Code-Plugin. Lokal einbinden:

```
/plugin marketplace add ~/IdeaProjects/werkstatt
/plugin install werkstatt@werkstatt-local
```

Zum Ausprobieren ohne Installation: `claude --plugin-dir ~/IdeaProjects/werkstatt`

Orchestrator einmalig bauen:

```
cd ~/IdeaProjects/werkstatt/orchestrator && npm install && npm run build && npm link
```

## Ablauf

Im Zielprojekt (z. B. [wannwo](../wannwo)) – die ersten Schritte interaktiv in Claude Code:

```
/werkstatt:project-init
/werkstatt:spec-interview Teilnehmende sollen über Terminvorschläge abstimmen können
```

Spec prüfen, Status auf `freigegeben` setzen, committen. Den Rest übernimmt der Orchestrator:

```
werkstatt run 001 --budget 5
```

`project-init` legt `AGENTS.md`, `werkstatt.json` und die Ordner für Specs und
Akzeptanztests an – in einem leeren Ordner auch das Projektgerüst. Die übrigen
Werkzeuge setzen das voraus.

## Orchestrator

`werkstatt run <Spec-ID>` führt eine freigegebene Spec ohne Zutun durch – jede Phase
in einer eigenen Agent-Session mit frischem Kontext:

1. **Vorbedingungen**: Spec ist `freigegeben`, keine uncommitteten Änderungen.
2. **Akzeptanztests**: `/werkstatt:derive-tests`, falls es noch keine Testdateien mit
   `Spec<Nummer>` im Namen gibt. Der Orchestrator prüft, dass sie entstanden und gesperrt sind.
3. **Implementierung**: Der Stop-Hook lässt den Agent erst aufhören, wenn `verify` grün
   ist. Danach prüft der Orchestrator selbst: Akzeptanztests unverändert, `verify` grün.
4. **Review**: eigene Session mit dem Agent `werkstatt:reviewer` – nur lesende Werkzeuge,
   Maßstab sind Spec und `AGENTS.md`. Bei `NACHBESSERN` geht es mit den Befunden zurück
   zu Schritt 3, bis `--attempts` (Standard 2) erreicht ist.
   Ist das Review bestanden, lässt aber Fragen offen, die die Spec nicht regelt, fragt der
   Orchestrator im Terminal nach: **so lassen**, **anders entscheiden** oder **später**.
   Entscheidungen werden im Abschnitt „Entscheidungen“ der Spec festgehalten; eine
   geänderte Entscheidung löst eine weitere Runde aus Implementierung und Review aus.
5. **Protokoll** nach `.werkstatt/state/runs/` – Phasen, Kosten, Turns, Ergebnis als JSON,
   jedes Review zusätzlich als lesbare Markdown-Datei (`…-review-<Versuch>.md`).

Der Orchestrator committet nicht. Die Sessions laufen ohne Rückfragen (`dontAsk`): erlaubt
sind Dateiwerkzeuge, Subagents, der Prüfbefehl und lesende Shell-/git-Befehle, alles
andere wird verweigert.

## Hooks

Aktiv, sobald das Plugin geladen ist und das Projekt eine `werkstatt.json` hat.

| Hook | Wirkung |
|------|---------|
| `PreToolUse` | Verweigert Schreibzugriffe auf gesperrte Akzeptanztests, `.werkstatt/` und `werkstatt.json` – auch offensichtliche Bash-Umwege (`rm`, `sed -i`, Umleitungen …). Neue Testdateien sind erlaubt. |
| `Stop` | Stellt veränderte gesperrte Tests aus der Sperrkopie wieder her und sperrt neue Testdateien. In der Implementierungsphase des Orchestrators (`WERKSTATT_PHASE=implement`) muss außerdem `verify` grün sein. |

Interaktiv blockiert der Stop-Hook also nur, wenn ein gesperrter Test verändert wurde.
Voraussetzung: `python3` ≥ 3.9.

Dateien im Zielprojekt:
- `.werkstatt/locks/` – Sperrliste und Sperrkopien. **Committen**, damit die Sperren für alle gelten.
- `.werkstatt/state/` – lokale Protokolle der Läufe, ignoriert sich selbst.

### Befehle für den Nutzer

Im Claude-Code-Prompt mit `!` ausführen – der Agent selbst darf `unlock` nicht aufrufen.

```
! python3 ~/IdeaProjects/werkstatt/hooks/werkstatt.py status
! python3 ~/IdeaProjects/werkstatt/hooks/werkstatt.py unlock Spec001   # Tests entsperren (Pfad-Teil)
```
