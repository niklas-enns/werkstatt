# werkstatt

Werkzeuge für Softwareentwicklung, bei der Coding-Agents den Code schreiben.
Menschen spezifizieren und geben frei, Agents setzen um, automatische Prüfungen
und ein unabhängiges Review sichern die Qualität.

## Werkzeuge

| Werkzeug                  | Art                    | Stand         |
|---------------------------|------------------------|---------------|
| `project-init`            | Skill                  | erste Version |
| `spec-interview`          | Skill                  | erste Version |
| `derive-tests`            | Skill                  | erste Version |
| Akzeptanztests sperren    | Hooks                  | erste Version |
| Stop-Gate (verify + Review) | Hook                 | erste Version |
| `reviewer`                | Subagent               | erste Version |
| Orchestrator (`werkstatt run`)| Agent SDK (TypeScript) | erste Version |
| Metriken-Auswertung       | –                      | geplant       |

## Einrichten

werkstatt ist ein Claude-Code-Plugin. Lokal einbinden:

```
/plugin marketplace add ~/IdeaProjects/werkstatt
/plugin install werkstatt@werkstatt-local
```

Zum Ausprobieren ohne Installation: `claude --plugin-dir ~/IdeaProjects/werkstatt`

## Benutzen

Im Zielprojekt (z. B. [wannwo](../wannwo)):

```
/werkstatt:project-init
/werkstatt:spec-interview Teilnehmende sollen über Terminvorschläge abstimmen können
# Spec prüfen, Status auf "freigegeben" setzen
/werkstatt:derive-tests 001
```

Danach implementiert der Agent wie gewohnt. Die Hooks sorgen dafür, dass er erst
aufhören kann, wenn `verify` grün ist und der Subagent `werkstatt:reviewer` die
Änderung gegen die Spec abgenommen hat.

`project-init` legt `AGENTS.md`, `werkstatt.json` und die Ordner für Specs und
Akzeptanztests an – in einem leeren Ordner auch das Projektgerüst. Die übrigen
Werkzeuge setzen das voraus.

## Orchestrator

`werkstatt run <Spec-ID>` führt eine freigegebene Spec ohne Zutun durch – jede Phase
in einer eigenen Agent-Session mit frischem Kontext:

1. **Vorbedingungen**: Spec ist `freigegeben`, keine uncommitteten Änderungen, Stop-Gate aktiv.
2. **Akzeptanztests**: `/werkstatt:derive-tests`, falls es noch keine Testdateien mit
   `Spec<Nummer>` im Namen gibt. Der Orchestrator prüft, dass sie entstanden und gesperrt sind.
3. **Implementierung**: Die Hooks erzwingen in der Session verify und Review. Danach prüft
   der Orchestrator selbst: Tests unverändert, verify grün, Stand vom Reviewer freigegeben.
   Wenn nicht, startet er einen neuen Versuch mit seinem Befund als Rückmeldung.
4. **Protokoll** nach `.werkstatt/state/runs/` – Phasen, Kosten, Turns, Ergebnis.

Der Orchestrator committet nicht. Die Sessions laufen ohne Rückfragen (`dontAsk`): erlaubt
sind Dateiwerkzeuge, Subagents, der Prüfbefehl und lesende Shell-/git-Befehle, alles
andere wird verweigert.

```
cd orchestrator && npm install && npm run build && npm link   # einmalig
cd ~/IdeaProjects/wannwo
werkstatt run 001 --budget 5
```

Aktiv, sobald das Plugin geladen ist und das Projekt eine `werkstatt.json` hat.

| Hook | Wirkung |
|------|---------|
| `PreToolUse` | Verweigert Schreibzugriffe auf gesperrte Akzeptanztests, `.werkstatt/` und `werkstatt.json` – auch offensichtliche Bash-Umwege (`rm`, `sed -i`, Umleitungen …). Neue Testdateien sind erlaubt. |
| `Stop` | 1. Veränderte gesperrte Tests werden aus der Sperrkopie wiederhergestellt, neue Testdateien gesperrt.<br>2. Hat sich Produktionscode seit dem letzten freigegebenen Stand geändert (Specs und Akzeptanztests zählen nicht), muss `verify` grün sein.<br>3. Danach wird ein Review durch `werkstatt:reviewer` verlangt. Erst bei `BESTANDEN` gilt der Stand als freigegeben. |
| `SubagentStop` | Übernimmt das Urteil des Reviewers. |
| `SessionStart` | Setzt beim ersten Mal den aktuellen Stand als Ausgangspunkt. |

Nach 8 Blockaden in Folge lässt das Gate den Agent mit einer Warnung aufhören.
Voraussetzungen: `git` (für die Änderungserkennung) und `python3` ≥ 3.9.

Dateien im Zielprojekt:
- `.werkstatt/locks/` – Sperrliste und Sperrkopien. **Committen**, damit die Sperren für alle gelten.
- `.werkstatt/state/` – lokaler Zustand und Review-Berichte, ignoriert sich selbst.

### Befehle für den Nutzer

Im Claude-Code-Prompt mit `!` ausführen – der Agent selbst darf `unlock`, `pause` und `resume` nicht aufrufen.

```
! python3 ~/IdeaProjects/werkstatt/hooks/werkstatt.py status
! python3 ~/IdeaProjects/werkstatt/hooks/werkstatt.py unlock Spec001   # Tests entsperren (Pfad-Teil)
! python3 ~/IdeaProjects/werkstatt/hooks/werkstatt.py pause            # Stop-Gate aus
! python3 ~/IdeaProjects/werkstatt/hooks/werkstatt.py resume           # Stop-Gate an
```
