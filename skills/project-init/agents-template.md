# AGENTS.md – <Projektname>

Dieses Dokument richtet sich an Coding-Agents. Es beschreibt, was das Projekt ist,
wie man es baut und prüft und welche Regeln gelten.

## Worum geht es?

<Zwei bis vier Sätze: Was das System tut und für wen.>

Fachliche Anforderungen stehen **ausschließlich** in `<specs-Ordner>/`. Was dort nicht
steht, ist nicht beauftragt. Bei Unklarheiten: nachfragen statt raten.

## Bauen und prüfen

| Zweck                   | Befehl              |
|-------------------------|---------------------|
| Bauen und alle Tests    | `<Prüfbefehl>`      |
| Anwendung starten       | `<Startbefehl>`     |
| <weitere, falls nützlich> | `<…>`             |

Eine Aufgabe ist erst erledigt, wenn `<Prüfbefehl>` grün ist.

## Struktur

- `<specs-Ordner>/` – Specs, eine Datei pro Feature. Nur Menschen geben Specs frei.
- `<Akzeptanztest-Ordner>/` – Akzeptanztests, aus Specs abgeleitet.
  **Nicht verändern**, um sie grün zu bekommen. Wenn ein Akzeptanztest falsch
  erscheint: stoppen und melden.
- `<Produktionscode>/` – Produktionscode.
- <weitere wichtige Orte>

## Konventionen

- <Sprache, Framework-Version, zentrale Bibliotheken>
- <Belegbare Regeln aus Linter, CI, bestehender Doku oder vom Nutzer genannt>
