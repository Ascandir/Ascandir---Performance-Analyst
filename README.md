# Ascandir - Performance Analyst

Findet heraus, **welches Modul dein Foundry ausbremst**. Das Modul misst im Hintergrund, wie viel Rechenzeit jedes installierte Modul verbraucht, ordnet Ruckler einem Verursacher zu und prüft Konsole, Dateien, Texturen und Einstellungen auf typische Performance-Fresser. Alles lässt sich aufzeichnen und exportieren.

Funktioniert **spielsystemunabhängig**. Getestet mit Foundry v14.368 (ab v13 lauffähig), dnd5e 6.0.6.

## Installation

In Foundry unter **Add-on Modules → Install Module** diese Manifest-URL einfügen:

```
https://github.com/Ascandir/Ascandir---Performance-Analyst/releases/latest/download/module.json
```

## Öffnen

- **Spieleinstellungen → Ascandir - Performance Analyst → Analyse öffnen**
- oder Tastenkürzel **Alt + Umschalt + P**
- oder unten im Einstellungs-Tab der Seitenleiste der Button **Performance Analyst**

## Was gemessen wird

| Bereich | Was du siehst |
|---|---|
| **Module** | Rechenzeit pro Modul, getrennt in *Startzeit* (bis die Welt bereit ist) und *Laufzeit* (danach), Anzahl Aufrufe, langsamster Aufruf, die teuersten Hooks des Moduls (Zeile anklicken) |
| **Ruckler** | Bilder, die länger als 50 ms gebraucht haben, mit den Modulen, die in diesem Moment gerechnet haben. Dazu Bildraten-Verlauf und Szenen-Ladezeiten |
| **Dateien** | Alle geladenen Bilder, Sounds, Videos und Skripte mit Größe und Ladezeit. Bilder der aktuellen Szene mit Pixelgröße und geschätztem Grafikspeicher. Nicht gefundene Dateien |
| **Konsole** | Fehler, Warnungen und veraltete Foundry-Aufrufe, zusammengefasst und dem Modul zugeordnet |
| **Netzwerk** | Nachrichten pro Modul und wer wie viele Dokument-Änderungen auslöst |
| **Welt** (SL) | Wie viele Daten jedes Modul in Akteuren, Gegenständen, Szenen usw. und in Einstellungen speichert, auch von deaktivierten Modulen |
| **Spieler** (SL) | Sammelt die Messwerte aller verbundenen Spieler-Browser ein |

## Hintergrund-Prüfungen

Das Modul meldet automatisch unter anderem:

- **Grafikkarte wird nicht genutzt** (Software-Rendering, z. B. Hardwarebeschleunigung aus)
- **Debug-Schalter aktiv** (z. B. `CONFIG.debug.hooks`)
- **Zu große Bilder, Audio- und Videodateien**, mit Tipp (WebP, OGG, WebM)
- **Bilder größer als die Grafikkarte erlaubt** und sehr hoch aufgelöste Karten
- **Zu viel Grafikspeicher** in einer Szene
- **Fehler-Spam** und Module, die ständig veraltete Funktionen aufrufen
- **Nicht ladbare Dateien**
- **Sehr viele Dokument-Änderungen pro Sekunde**
- **Sehr viele HTML-Elemente**, wachsender Speicher (möglicher Speicherleck)
- **Module, die nicht für deine Foundry-Version freigegeben sind**
- **Langer Chat-Verlauf**, langsam ladende Szenen, viele Lichter, Wände oder Token

Kritische Probleme erscheinen beim SL als Benachrichtigung. Das kann in den Einstellungen geändert werden.

## Aufzeichnung (zum gezielten Testen)

1. Fenster öffnen → **Aufzeichnen** oben rechts oder im Tab **Berichte** (5 Min, 15 Min oder bis du stoppst).
2. Das tun, was ruckelt: Szene wechseln, Kampf starten, Token bewegen …
3. Während der Aufnahme kannst du **Markierungen** setzen („Kampf beginnt“), sie landen in der Zeitleiste.
4. Stoppen. Die Aufzeichnung wird gespeichert und angezeigt.

Oben am Bildschirmrand zeigt eine kleine Anzeige, dass gerade aufgezeichnet wird.

## Export

Im Tab **Berichte**:

- **Zusammenfassung kopieren**: kurzer Text mit allem Wichtigen, zum Einfügen in einen Chat oder ein Ticket
- **Vollständig (JSON)**: alle Daten, bei Aufzeichnungen inklusive Zeitleiste jedes Aufrufs über 0,5 ms
- **Modultabelle (CSV)**: lässt sich in Excel/LibreOffice öffnen

Die letzten 5 Aufzeichnungen bleiben im Browser auch nach einem Neuladen erhalten.

## Ehrlich: Was das Modul nicht kann

- **Kein „RAM pro Modul“.** Alle Module laufen im selben Browser-Thread. Der Browser verrät nur den Gesamtspeicher (und den nur in Chrome, Edge und der Foundry-App, nicht in Firefox).
- **Gemessen wird Code, der über Hooks oder libWrapper läuft.** Das ist der allergrößte Teil. Module, die Foundry-Funktionen direkt überschreiben, fallen teilweise durchs Raster. Ihre Zeit taucht dann in den Rucklern als „Canvas-Rendering / Browser“ auf.
- **Asynchroner Code** (alles nach einem `await`) wird nur bis zur ersten Wartestelle gemessen.
- **Ruckler-Zuordnung:** In Chrome, Edge und der Foundry-App liefert der Browser die Verursacher selbst („Long Animation Frames“). In Firefox schließt das Modul aus den gemessenen Hook-Zeiten auf den Verursacher. Das ist etwas ungenauer.
- **Die Messung kostet selbst ein wenig Zeit.** Der Wert steht in der Übersicht unter „Messaufwand“. Wenn du nichts testest, kannst du die Hintergrund-Überwachung in den Einstellungen ausschalten.
- **„Konsole mitlesen“** hat eine Nebenwirkung: In den Entwicklertools des Browsers (F12) steht bei Meldungen dieses Modul als Absender. Die Meldungen selbst bleiben unverändert.

## Einstellungen

- **Hintergrund-Überwachung**: alles an oder aus (pro Browser, wirkt nach Neuladen)
- **Konsole mitlesen**: Fehler, Warnungen und veraltete Aufrufe zählen (pro Browser)
- **Hinweise einblenden**: nie / nur kritisch / kritisch und Warnungen (nur SL)
- **Fenster automatisch aktualisieren**
- **Spieler-Berichte erlauben** (Welt, nur SL)
- **Grenzen für Bilder, Audio und Video** in MB (Welt, nur SL)

## Für Makros

```js
const apa = game.modules.get("ascandir-performance-analyst").api;
apa.open();
apa.startRecording(5, "Kampf Taverne");   // Minuten, Name
apa.stopRecording();
apa.summary();                           // Text-Zusammenfassung
apa.report();                            // kompletter Bericht als Objekt
```
