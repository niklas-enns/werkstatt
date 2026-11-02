---
name: derive-tests
description: Leitet aus einer freigegebenen Spec ausführbare Akzeptanztests ab – mindestens einen pro Akzeptanzkriterium (AK-ID), gegen die öffentliche Schnittstelle, ohne Produktionscode. Verwenden, nachdem eine Spec freigegeben wurde und bevor implementiert wird.
argument-hint: <Spec-ID oder Pfad, z. B. 001>
---

# Akzeptanztests ableiten

Ziel: Für eine freigegebene Spec entstehen Tests, die **vor** der Implementierung
festlegen, wann das Feature fertig ist. Sie kommen bewusst nicht vom selben Agent-Lauf,
der später implementiert, und werden danach nicht mehr angepasst, um grün zu werden.

Spec: $ARGUMENTS

## Ablauf

### 1. Voraussetzungen prüfen – bei einem Verstoß abbrechen und melden

- `werkstatt.json` existiert im Projektwurzelverzeichnis. Sonst: auf
  `/werkstatt:project-init` verweisen. Daraus lesen: `specs`, `acceptanceTests`,
  `commands.verify`.
- Die Spec existiert. Bei einer Nummer: `<specs>/<Nummer>-*.md`.
- Der Status im Frontmatter ist **`freigegeben`**. Einen `entwurf` nicht bearbeiten,
  auch nicht auf Bitte im selben Atemzug – die Freigabe setzt der Nutzer in der Datei.
- Die Spec hat einen Abschnitt **Schnittstelle**, der die Aufrufe der Akzeptanzkriterien
  beschreibt. Fehlt er oder reicht er nicht: Lücke konkret benennen, einen Vorschlag
  machen und abbrechen. Die Spec ändert der Nutzer (oder `spec-interview`), nicht dieser Skill.
- Jedes Akzeptanzkriterium ist prüfbar formuliert. Ein unprüfbares Kriterium nicht
  „sinnvoll interpretieren“, sondern als Problem der Spec melden.

### 2. Bestehende Tests feststellen

Suche im Akzeptanztest-Ordner nach Tests zu dieser Spec (Spec-ID im Namen).
- **Keine vorhanden** → alle Kriterien ableiten.
- **Vorhanden** → nur fehlende AK-IDs ergänzen. Tests zu Kriterien, deren Text sich
  geändert hat, nicht still überschreiben: Änderung zeigen und Bestätigung einholen.

### 3. Tests schreiben

Orientiere dich an den Konventionen in `AGENTS.md` und vorhandenen Tests des Projekts.

- **Nur** in den Ordner `acceptanceTests`. Kein Produktionscode, keine Änderungen an
  Build-Dateien – außer eine Test-Abhängigkeit fehlt zwingend; dann vorher fragen.
- **Black-Box**: nur über die Schnittstelle aus der Spec (HTTP, CLI, öffentliche API).
  Keine Imports aus dem Produktionscode, der noch nicht existiert – die Tests müssen
  ohne Implementierung kompilieren.
- **Rückverfolgbar**: Der Dateiname enthält `Spec<Nummer>` (z. B. `Spec001…`) – daran
  erkennen Orchestrator und Reviewer die Tests einer Spec. Die AK-ID steht im Namen oder in der
  Beschreibung jedes Testfalls, z. B. `Spec001PollCreationAcceptanceTest` mit
  `@DisplayName("AK-3: Abstimmung ohne Terminvorschlag wird abgelehnt")`.
- **Ein Kriterium, ein Testfall**. Weitere Fälle zum selben Kriterium nur, wenn die Spec
  sie mit konkreten Werten nennt.
- **Werte aus der Spec übernehmen**, nicht ausdenken. Wo die Spec keine Werte nennt
  (z. B. ein Titel), neutrale Testdaten wählen, die das Kriterium nicht beeinflussen.
- **Unabhängig**: Jeder Test legt seine Ausgangslage („Gegeben“) selbst über die
  Schnittstelle an und verlässt sich nicht auf Reihenfolge oder Daten anderer Tests.
- **Prüfen, was die Spec sagt** – nicht mehr. Keine Annahmen über Felder, Formate oder
  Statuscodes, die die Spec nicht festlegt.

### 4. Ausführen und Rot-Grund prüfen

Führe `commands.verify` aus. Erwartet ist: **kompiliert, die neuen Tests schlagen fehl.**
- Jeder neue Test muss **aus dem richtigen Grund** rot sein – das Verhalten fehlt
  (z. B. 404, falscher Status, fehlendes Feld), nicht ein Fehler im Test selbst.
- Ein Test, der schon jetzt grün ist, prüft vermutlich nichts. Ursache klären: Ist das
  Verhalten tatsächlich schon vorhanden, oder ist der Test zu schwach?
- Kompilier- oder Setup-Fehler im Test beheben, bevor du berichtest.

### 5. Berichten

- Tabelle: AK-ID → Testklasse/-methode → Ergebnis (rot, mit Grund in Stichworten).
- Kriterien ohne Test und warum.
- Hinweis: Die Tests sind jetzt die Vorgabe für die Implementierung und werden nicht
  angepasst, um grün zu werden. Ist ein Test falsch, wird erst die Spec geklärt.
