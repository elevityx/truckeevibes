# Fixtures

Fixtures keep the structure of a real source response (element names, field layout, date and time formats, markup) and replace
all human-written text with synthetic text. Rules:

- No real titles, descriptions, names, addresses or contact details. Use made-up text such as "Sample Concert" or "Example Hall".
- Keep dates, times, time zones and markup, because the parsers are tested against them.
- At most 64 KB per file and 2 MB in total, no image files. `npm run check:repo` enforces this.
