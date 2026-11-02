---
name: project-init
description: Richtet ein Projekt für die Arbeit mit Coding-Agents und der werkstatt ein – legt bei leerem Ordner ein Grundgerüst an, ergänzt bei bestehenden Projekten nur das Fehlende (AGENTS.md, werkstatt.json, Spec- und Akzeptanztest-Ordner). Verwenden, wenn ein Projekt neu startet oder zum ersten Mal mit der werkstatt genutzt wird.
argument-hint: "[kurze Beschreibung des Projekts]"
---

# Projektinitialisierung

Ziel: Nach diesem Skill kann ein Coding-Agent im Projekt selbstständig arbeiten –
er weiß, worum es geht, wie man baut und prüft, wo Specs und Akzeptanztests liegen,
und ein einziger Befehl sagt ihm, ob alles grün ist.

Beschreibung vom Nutzer (optional): $ARGUMENTS

## Ergebnis

| Datei / Ordner          | Zweck                                                         |
|-------------------------|---------------------------------------------------------------|
| `AGENTS.md`             | Kontext und Regeln für Agents, nach [agents-template.md](agents-template.md) |
| `CLAUDE.md`             | Enthält `@AGENTS.md`, damit Claude Code dieselbe Quelle nutzt |
| `werkstatt.json`        | Maschinenlesbare Angaben für andere werkstatt-Werkzeuge, nach [werkstatt-template.json](werkstatt-template.json) |
| `docs/specs/`           | Specs, eine Datei pro Feature                                 |
| Akzeptanztest-Ordner    | Aus Specs abgeleitete Tests, Pfad passend zum Stack           |
| Smoke-Test              | Mindestens ein Test, damit der Prüfbefehl etwas prüft         |

## Ablauf

### 1. Ausgangslage feststellen

Prüfe das aktuelle Verzeichnis:
- **Leer** (höchstens `.git`, README o. ä.) → *neues Projekt*, weiter mit Schritt 2a.
- **Code vorhanden** → *bestehendes Projekt*, weiter mit Schritt 2b.
- Gibt es schon eine `werkstatt.json`, ist das Projekt bereits eingerichtet: nur prüfen,
  ob alles noch stimmt, und Abweichungen melden.

### 2a. Neues Projekt

1. Frage (AskUserQuestion, eine Runde): Zweck des Projekts (falls nicht in `$ARGUMENTS`),
   Stack, Projekt-/Package-Name. Schlage einen Stack vor, wenn der Nutzer keinen nennt.
2. Erzeuge das Gerüst mit dem **offiziellen Generator** des Stacks (z. B.
   `quarkus-maven-plugin:create`, Spring Initializr, `npm create vite`, `uv init`) statt
   Dateien von Hand zu schreiben. Nur die Erweiterungen, die für einen Start nötig sind –
   weitere kommen später über Specs.
3. Lege einen Smoke-Test an (z. B. Health-Endpoint oder trivialer Unit-Test).
4. `git init`, falls noch kein Repository existiert. Nicht committen.

### 2b. Bestehendes Projekt

Ermittle selbst, ohne zu fragen:
- **Stack und Build-Tool** aus Build-Dateien (`pom.xml`, `build.gradle*`, `package.json`,
  `pyproject.toml`, `go.mod`, `Cargo.toml`, …).
- **Prüfbefehl**: der eine Befehl, der baut und alle Tests ausführt (bevorzugt Wrapper wie
  `./mvnw`, `./gradlew`). Bei mehreren Kandidaten den umfassendsten.
- **Startbefehl** für die laufende Anwendung, falls es eine gibt.
- **Struktur**: wo Produktionscode und Tests liegen, wie Packages geschnitten sind.
- **Konventionen**, die sich belegen lassen: Linter-/Formatter-Konfiguration, CI-Dateien,
  vorhandene `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, `.editorconfig`.

Schreibe keine Konventionen in die `AGENTS.md`, die du nur vermutest.

### 3. Prüfbefehl ausführen

Führe den Prüfbefehl einmal aus.
- **Grün** → weiter.
- **Rot** → nichts reparieren. Dem Nutzer zeigen, was fehlschlägt, und fragen, ob trotzdem
  weitergemacht werden soll. Ein roter Ausgangszustand gehört in die Zusammenfassung.

### 4. Nachfragen, was sich nicht ermitteln lässt

Eine Runde AskUserQuestion, höchstens 4 Fragen, nur zu echten Lücken. Typisch:
- Zweck des Projekts und wichtigste Fachbegriffe (bei bestehenden Projekten, falls kein
  README das beantwortet).
- Wo Akzeptanztests liegen sollen – mit einem Vorschlag passend zum Stack.
- Regeln, die nicht im Code stehen (z. B. „keine neuen Abhängigkeiten ohne Begründung“,
  Zeitzonen-Handling, Sprache für Bezeichner).

### 5. Dateien schreiben

- **Nichts Bestehendes überschreiben.** Existiert `AGENTS.md` oder `CLAUDE.md` schon:
  fehlende Abschnitte ergänzen und dem Nutzer die Änderung zeigen.
- `CLAUDE.md`: wenn nicht vorhanden, nur `@AGENTS.md`; wenn vorhanden, die Zeile
  `@AGENTS.md` oben ergänzen, falls sie fehlt.
- `AGENTS.md` nach [agents-template.md](agents-template.md). Kurz halten: Agents lesen sie
  bei jeder Aufgabe. Was nicht hilft, eine Aufgabe richtig zu erledigen, gehört nicht hinein.
- `werkstatt.json` nach [werkstatt-template.json](werkstatt-template.json). Alle Pfade
  relativ zum Projektwurzelverzeichnis.
- Leere Ordner mit `.gitkeep` anlegen.

### 6. Abschließend prüfen und berichten

1. Prüfbefehl erneut ausführen – er muss im selben Zustand sein wie in Schritt 3.
2. Zusammenfassung in wenigen Zeilen: was angelegt oder ergänzt wurde, der Prüfbefehl
   und sein Ergebnis, offene Punkte.
3. Nächsten Schritt nennen: das erste Feature mit `/werkstatt:spec-interview` spezifizieren.
