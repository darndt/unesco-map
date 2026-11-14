# World Heritage Map

Interactive map of all UNESCO World Heritage Sites (cultural, natural, mixed).

- **Map:** MapLibre GL + [OpenFreeMap](https://openfreemap.org) "Liberty" vector tiles
- **Server:** Ruby (Sinatra + Puma), data in SQLite via Sequel
- **Data:** official UNESCO list ([data.unesco.org](https://data.unesco.org/explore/dataset/whc001/)),
  linked to Wikidata (property P757) for Wikipedia articles and Commons images
- **Descriptions:** written fresh for each site by Claude from UNESCO and Wikipedia facts

## Setup

```sh
bundle install                        # Ruby 4.0.9 (see .ruby-version); skips the :import group if configured
bundle exec rake import:data          # UNESCO + Wikidata + Wikipedia (~10 min, Wikipedia is rate-limited)
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .env   # or export it in your shell
BUNDLE_WITH=import bundle install     # the Anthropic SDK is only needed for descriptions
bundle exec rake import:descriptions  # ~1,270 Claude calls, resumable
bundle exec rake stats
bundle exec rackup -p 9393            # http://localhost:9393
```

Until descriptions are generated, popups show the first two sentences of the Wikipedia intro.

### Description options

| env var            | default            | meaning                                   |
| ------------------ | ------------------ | ----------------------------------------- |
| `LIMIT=20`         | all                | only write N descriptions (try it first)  |
| `FORCE=1`          | off                | regenerate existing descriptions          |
| `DESCRIBE_MODEL`   | `claude-sonnet-5-5`| Claude model                              |
| `DESCRIBE_THREADS` | `4`                | parallel requests                         |

Raw downloads are cached in `data/raw/`; run any import with `REFRESH=1` to re-download.

## Features

- Dots coloured by type (orange cultural, green natural, purple mixed); red ring = List of World Heritage in Danger
- Type filters and an "in danger only" toggle
- Search by site name or country (accent-insensitive, keyboard navigable)
- Popup: image, generated description, links to UNESCO, Wikipedia and Wikidata
- Shareable links: `/?site=668` opens Angkor
