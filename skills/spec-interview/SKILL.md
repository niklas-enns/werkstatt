---
name: spec-interview
description: Macht aus einem groben Ticket oder einer Idee eine prüfbare Spec, indem der Nutzer gezielt befragt wird. Verwenden, wenn ein neues Feature spezifiziert werden soll, bevor Code oder Tests entstehen.
argument-hint: <Ticket-Text oder Feature-Idee>
---

# Spec-Interview

Dein Ergebnis ist **eine Spec-Datei**, kein Code und keine Tests. Der Nutzer
entscheidet über alles Fachliche – du stellst die richtigen Fragen und schreibst
sauber auf.

Auftrag: $ARGUMENTS

## Ablauf

1. **Kontext lesen**
   - `AGENTS.md` (bzw. `CLAUDE.md`) des Projekts.
   - Bestehende Specs in `docs/specs/`, um Begriffe, Nummerierung und Abhängigkeiten zu kennen.
   - Code nur so weit, wie nötig, um vorhandenes Verhalten nicht falsch zu beschreiben.

2. **Lücken finden** – gehe die Prüfliste unten durch und notiere für dich, was der
   Auftrag offen lässt. Triff keine fachlichen Annahmen stillschweigend.

3. **Befragen** – in Runden von höchstens 4 Fragen (AskUserQuestion), wichtigste zuerst.
   - Biete konkrete Antwortoptionen an, mit einer Empfehlung, wenn du eine hast.
   - Frage nach Beispielen mit echten Werten ("Was passiert, wenn …?"), nicht nach Abstraktem.
   - Höre auf, wenn jedes Akzeptanzkriterium eindeutig prüfbar ist. Lieber eine Runde
     weniger und offene Punkte unter "Offene Fragen" sammeln.

4. **Spec schreiben** nach `docs/specs/NNN-<slug>.md` (nächste freie Nummer, dreistellig)
   anhand von [spec-template.md](spec-template.md). Status ist immer `entwurf`.

5. **Übergeben** – fasse in wenigen Zeilen zusammen, was spezifiziert ist, was offen
   bleibt und was der Nutzer vor der Freigabe prüfen sollte. Nur der Nutzer setzt
   den Status auf `freigegeben`. Nenne danach genau diese nächsten Schritte:
   1. Spec prüfen und im Kopf der Datei `status: freigegeben` setzen.
   2. Committen.
   3. Im Terminal `werkstatt run <Nummer>` ausführen – der Orchestrator leitet die
      Akzeptanztests ab, implementiert und lässt reviewen.

   Verweise nicht auf `derive-tests` oder darauf, selbst zu implementieren – das
   übernimmt der Orchestrator.

## Prüfliste

- **Ziel**: Welches Problem löst das Feature, für wen?
- **Akteure und Rechte**: Wer darf was? Was passiert bei fehlender Berechtigung?
- **Regeln**: Grenzwerte, Fristen, Zustandsübergänge, Berechnungen.
- **Randfälle**: leere Eingaben, Maximalwerte, Gleichstand, Gleichzeitigkeit, Zeitzonen,
  Zeitpunkte in der Vergangenheit.
- **Fehlerfälle**: Was sieht der Aufrufer bei ungültiger Eingabe?
- **Schnittstelle**: Über welche Aufrufe wird das Verhalten ausgelöst und beobachtet
  (z. B. Endpunkte, Payloads, Statuscodes)? Schlage einen konkreten Entwurf vor, passend
  zu vorhandenen Schnittstellen, und lass ihn bestätigen – Akzeptanztests werden dagegen
  geschrieben.
- **Abgrenzung**: Was ausdrücklich *nicht* Teil dieses Features ist.

## Regeln für Akzeptanzkriterien

- Jedes Kriterium hat eine stabile ID (`AK-1`, `AK-2`, …), auf die Tests später verweisen.
- Form: **Gegeben** … **Wenn** … **Dann** …, mit konkreten Werten.
- Ein Kriterium prüft genau ein Verhalten.
- Beschreibe beobachtbares Verhalten (Schnittstelle, Antwort, Zustand), keine Implementierung.
- Jedes Kriterium ist allein über die Aufrufe im Abschnitt **Schnittstelle** prüfbar.
