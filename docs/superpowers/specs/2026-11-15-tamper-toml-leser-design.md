# Tamper: pyproject.toml mit TOML-Leser prüfen

Stand: 15.11.2026. Kleine Änderung, kurzes Design.

## Absicht

Der Tamper-Check soll eine abgeschwächte ruff-, mypy- oder pytest-Konfiguration
in `pyproject.toml` finden, egal in welcher TOML-Schreibweise sie steht. Heute
vergleicht `manifestGateChanges` nur den Text ganzer Abschnitte. Das Review vom
14.11.2026 hat drei Umgehungen nachgestellt:

- `[tool]` mit `ruff.lint.ignore = ["ALL"]`
- `tool.mypy.ignore_errors = true` auf oberster Ebene
- `[tool."ruff"]` mit Anführungszeichen

Dazu können `setup.cfg`, `tox.ini` und `.flake8` dieselbe Konfiguration tragen
und stehen in keiner Liste.

## Ziele und Nicht-Ziele

- Ziel: Die drei Umgehungen melden `protected.changed`.
- Ziel: Ein Fehler des Lesers verschluckt keinen Fund.
- Nicht-Ziel: ein vollständiger TOML-Parser. Das Paket hat keine
  Laufzeit-Abhängigkeiten, weil es auch über Composer ohne `node_modules` läuft.
- Anti-Ziel: Fehlalarme bei neuen Abhängigkeiten oder einem Versionssprung.

## Ansätze

1. **Enger TOML-Leser plus Textvergleich als Rückfall (gewählt).** Der Leser
   versteht die Syntax, die in `pyproject.toml` vorkommt. Bei allem anderen
   wirft er, und der heutige Textvergleich greift.
2. **`pyproject.toml` ganz als `reportOnly`.** Einfach, aber jede neue
   Abhängigkeit meldet. Python setzt kein getrenntes Lockfile voraus.
3. **Textvergleich erweitern** (Regex für gepunktete Schlüssel). Bleibt
   lückenhaft, weil TOML zu viele gleichwertige Schreibweisen hat.

René hat am 15.11.2026 Ansatz 1 bestätigt. Für `setup.cfg`, `tox.ini` und
`.flake8` hat er `reportOnly` in `PROTECTED_PATHS` gewählt, wie bei `pytest.ini`.

## Entwurf

- `lib/toml.mjs` mit `parseToml(text)` und `TomlError`, nach dem Vorbild von
  `lib/yaml.mjs`. Unterstützt: Tabellen, Tabellenlisten, gepunktete und
  gequotete Schlüssel, Basic- und Literal-Strings, Zahlen, Wahrheitswerte,
  Listen (auch mehrzeilig), Inline-Tabellen, Kommentare. Alles andere wirft.
- `manifestGateChanges` liest beide Fassungen. Wirft der Leser bei einer
  Fassung, bleibt der Textvergleich (`tomlSections`).
- Verglichen werden `tool.ruff`, `tool.mypy` und `tool.pytest`. Der gemeldete
  Name ist die tiefste Tabelle, in der sich ein Wert ändert. So bleiben die
  heutigen Namen wie `tool.ruff.lint` gleich.

## Dem Umsetzer überlassen

Fehlertexte des Lesers, interne Aufteilung von `lib/toml.mjs`.
