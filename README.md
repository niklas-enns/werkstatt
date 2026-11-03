<div align="center">

# werkstatt

**Spezifikationsgetriebene Entwicklung mit Coding-Agents – mit Leitplanken, die halten.**

Du legst fest, *was* gebaut wird. Agents bauen es.
Gesperrte Akzeptanztests und ein unabhängiges Review sorgen dafür, dass am Ende das herauskommt, was in der Spec steht.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-orange.svg)](https://github.com/niklas-enns/werkstatt/releases)
[![Claude Code Plugin](https://img.shields.io/badge/Claude%20Code-Plugin-d97757.svg)](https://code.claude.com/docs/en/plugins)

</div>

---

## Warum?

Coding-Agents schreiben schnell Code. Schwierig ist alles drumherum:

- **Was genau soll gebaut werden?** Implizites Wissen, Randfälle und Fachregeln stehen selten im Ticket.
- **Stimmt das Ergebnis?** Ein Agent, der seine eigenen Tests schreibt, bestätigt sich gern selbst – und passt im Zweifel den Test an statt den Code.
- **Wer prüft?** Menschen kommen beim Lesen von generiertem Code nicht hinterher.

werkstatt ist die Harness um den Agent herum, die diese Lücken schließt: Spec zuerst, Tests vor dem Code und gegen Änderungen gesperrt, deterministische Prüfungen außerhalb des Modells und ein Review mit frischem Blick.

## So funktioniert's

```mermaid
flowchart LR
    idea([Idee]) --> interview["/werkstatt:spec-interview"]
    interview --> spec[Spec mit<br/>Akzeptanzkriterien]
    spec --> release{{Du gibst frei}}
    release --> run["werkstatt run"]

    subgraph run_box [Orchestrator · jede Phase eine eigene Agent-Session]
        direction LR
        tests[test-writer<br/>leitet Tests ab] --> lock[(Tests<br/>gesperrt)]
        lock --> impl[implementer<br/>setzt um]
        impl --> verify{verify<br/>grün?}
        verify -- nein --> impl
        verify -- ja --> review[reviewer<br/>prüft gegen Spec]
        review -- nachbessern --> impl
    end

    run --> tests
    review -- bestanden --> done([Diff ansehen<br/>und committen])
```

1. **Spezifizieren** – Im Interview fragt ein Agent dich nach Regeln, Randfällen, Fehlerfällen und Schnittstelle, bis jedes Akzeptanzkriterium eindeutig prüfbar ist.
2. **Freigeben** – Nur du setzt eine Spec auf `freigegeben`.
3. **Umsetzen lassen** – `werkstatt run` erledigt den Rest ohne Zutun:
   - Der **test-writer** übersetzt jedes Akzeptanzkriterium in einen ausführbaren Test. Die Tests werden **gesperrt**.
   - Der **implementer** setzt um. Er kann erst aufhören, wenn `verify` grün ist – und die gesperrten Tests kann er nicht ändern.
   - Der **reviewer** prüft die Änderung unabhängig gegen Spec und Konventionen. Bei Mängeln geht es mit seinen Befunden in eine weitere Runde.
4. **Entscheiden** – Lässt die Spec etwas offen, fragt werkstatt dich am Ende direkt im Terminal. Deine Entscheidung landet in der Spec.

## Was drin ist

| Baustein | Art | Aufgabe |
|---|---|---|
| `project-init` | Skill | Richtet ein Projekt ein: `AGENTS.md`, `werkstatt.json`, Ordner für Specs und Akzeptanztests – in einem leeren Ordner auch das Projektgerüst |
| `spec-interview` | Skill | Macht aus einer groben Idee per Befragung eine prüfbare Spec |
| `test-writer` | Agent | Leitet Black-Box-Akzeptanztests aus der Spec ab, einen pro Kriterium |
| `implementer` | Agent | Setzt die Spec um, bis die gesperrten Tests grün sind |
| `reviewer` | Agent | Prüft die Umsetzung gegen Spec und `AGENTS.md`, mit strukturiertem Urteil |
| Hooks | Hooks | Sperren Akzeptanztests gegen Änderungen, erzwingen grünes `verify` beim implementer |
| `werkstatt run` | Orchestrator (TypeScript, [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk)) | Steuert die Phasen, prüft selbst, wiederholt, fragt nach, protokolliert |

## Schnellstart

### 1. Plugin installieren

In Claude Code:

```
/plugin marketplace add niklas-enns/werkstatt
/plugin install werkstatt@werkstatt
```

### 2. Orchestrator installieren

```bash
git clone https://github.com/niklas-enns/werkstatt.git
cd werkstatt/orchestrator
npm install && npm run build && npm link
```

Danach steht der Befehl `werkstatt` überall zur Verfügung. Der Orchestrator nutzt deinen Claude-Code-Login oder `ANTHROPIC_API_KEY` und lädt die Agents und Hooks aus seinem eigenen Checkout.

### 3. Loslegen

Im Zielprojekt, in Claude Code:

```
/werkstatt:project-init
/werkstatt:spec-interview Eine Person legt eine Terminabstimmung mit mehreren Vorschlägen an
```

Spec lesen, im Kopf der Datei `status: freigegeben` setzen, committen. Dann im Terminal:

```bash
werkstatt run 001
```

## Der Orchestrator im Detail

```
werkstatt run <Spec-ID> [--attempts 2] [--budget <usd>] [--max-turns 150] [--model <id>] [--allow-dirty]
```

| Schritt | Was passiert | Wer prüft |
|---|---|---|
| Vorbedingungen | Spec ist `freigegeben`, Arbeitsverzeichnis ist sauber | Orchestrator |
| Akzeptanztests | `test-writer` schreibt Tests (Dateiname enthält `Spec<Nummer>`) und meldet, welcher Test welches Kriterium prüft – oder bricht ab, wenn die Spec nicht prüfbar ist | Orchestrator: Tests vorhanden und gesperrt |
| Implementierung | `implementer` setzt um | Stop-Hook: `verify` grün (schickt bis zu dreimal zurück) · Orchestrator: Tests unverändert, `verify` grün |
| Review | `reviewer` liefert `BESTANDEN` / `NACHBESSERN`, Befunde und offene Fragen | Orchestrator wertet das strukturierte Urteil aus |
| Nachbessern | Blockierende Befunde gehen als Auftrag in die nächste Runde | bis `--attempts` erreicht ist |
| Offene Fragen | Im Terminal: **so lassen**, **anders entscheiden** oder **später** – Entscheidungen landen im Abschnitt „Entscheidungen“ der Spec | du |

werkstatt committet nie. Jeder Lauf wird nach `.werkstatt/state/runs/` protokolliert – Phasen, Kosten, Turns, Ergebnis als JSON, jedes Review zusätzlich als lesbare Markdown-Datei.

Die Agent-Sessions laufen ohne Rückfragen: Erlaubt sind Dateiwerkzeuge, der Prüfbefehl und lesende Shell- und git-Befehle – alles andere wird verweigert.

## Schutz der Akzeptanztests

Die Hooks sind aktiv, sobald das Plugin geladen ist und das Projekt eine `werkstatt.json` hat – auch wenn du interaktiv mit Claude Code arbeitest.

| Hook | Wirkung |
|---|---|
| `PreToolUse` | Verweigert Schreibzugriffe auf gesperrte Akzeptanztests, `.werkstatt/` und `werkstatt.json` – auch offensichtliche Umwege über die Shell (`rm`, `sed -i`, Umleitungen …) |
| `Stop` | Stellt veränderte gesperrte Tests aus der Sperrkopie wieder her und sperrt neue Testdateien. In der Implementierungsphase muss außerdem `verify` grün sein – nach drei Zurückweisungen darf die Session trotzdem enden, der Orchestrator prüft ohnehin selbst |

Entsperren können nur Menschen:

```bash
werkstatt status              # gesperrte Akzeptanztests anzeigen
werkstatt unlock Spec001      # Tests entsperren, deren Pfad "Spec001" enthält
```

`.werkstatt/locks/` gehört ins Repository, damit die Sperren für alle gelten. `.werkstatt/state/` ignoriert sich selbst.

## Konfiguration

`project-init` legt eine `werkstatt.json` im Projekt an:

```json
{
  "version": 1,
  "specs": "docs/specs",
  "acceptanceTests": "src/test/java/com/example/acceptance",
  "commands": {
    "verify": "./mvnw verify",
    "run": "./mvnw quarkus:dev"
  }
}
```

Kontext und Konventionen für die Agents stehen in der `AGENTS.md` des Projekts.

## Voraussetzungen und Grenzen

**Voraussetzungen**
- [Claude Code](https://code.claude.com) mit Plugin-Unterstützung
- Node.js ≥ 20 (Orchestrator), Python ≥ 3.9 (Hooks), git
- Im Zielprojekt: **ein** Befehl, der baut und alle Tests ausführt

**Passt gut** für Backend- und Service-Projekte, deren Verhalten sich über eine Schnittstelle von außen testen lässt (HTTP, CLI, öffentliche API).

**Noch nicht gut** für
- UI-lastige Anwendungen, Datenanalysen oder Infrastruktur-Code – dort passt das Schema „Akzeptanztest gegen Schnittstelle“ schlechter
- mehrere Specs gleichzeitig in Arbeit – werkstatt arbeitet eine Spec nach der anderen ab
- geänderte Entscheidungen nach dem Review: Sie werden umgesetzt und reviewt, aber nicht durch neue Akzeptanztests abgesichert

## Projektstruktur

```
werkstatt/
├── .claude-plugin/     Plugin- und Marketplace-Manifest
├── skills/             project-init, spec-interview
├── agents/             test-writer, implementer, reviewer
├── hooks/              Sperre der Akzeptanztests, verify-Gate
└── orchestrator/       werkstatt run (TypeScript, Claude Agent SDK)
```

## Status

werkstatt ist ein frühes Experiment (v0.1). Die Abläufe funktionieren Ende-zu-Ende an einem Beispielprojekt, Schnittstellen und Dateiformate können sich aber noch ändern. Feedback und Issues sind willkommen.

Geplant: Auswertung der Laufprotokolle (Kosten, Versuche, Review-Befunde über mehrere Läufe).

## Lizenz

[Apache License 2.0](LICENSE)
