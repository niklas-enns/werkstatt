---
id: NNN
titel: <Kurzer Titel>
status: entwurf   # entwurf | freigegeben
abhaengig-von: [] # IDs anderer Specs
---

# NNN – <Kurzer Titel>

## Ziel

<Ein bis drei Sätze: welches Problem, für wen, warum jetzt.>

## Begriffe

- **<Begriff>**: <Bedeutung in diesem Projekt>

## Regeln

1. <Fachliche Regel, eindeutig formuliert>

## Schnittstelle

<Wie das Verhalten von außen aufgerufen und beobachtet wird – so konkret, dass
Akzeptanztests dagegen geschrieben werden können. Z. B. für HTTP:>

| Aufruf | Eingabe | Antwort |
|--------|---------|---------|
| `POST /…` | `{ … }` | `201`, `{ … }` |

<Fehlerantworten: Statuscode und was der Aufrufer erfährt.>

## Akzeptanzkriterien

### AK-1: <Kurzname>
- **Gegeben** <Ausgangszustand mit konkreten Werten>
- **Wenn** <Aktion>
- **Dann** <beobachtbares Ergebnis>

## Abgrenzung

- <Was ausdrücklich nicht Teil dieser Spec ist>

## Offene Fragen

- <Was der Nutzer noch entscheiden muss; leer, wenn nichts offen ist>

<!-- Der Abschnitt "## Entscheidungen" wird von `werkstatt run` angehängt, wenn der
     Nutzer offene Fragen aus dem Review beantwortet. Nicht von Hand anlegen. -->
