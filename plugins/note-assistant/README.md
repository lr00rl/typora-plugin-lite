# Note Assistant

`note-assistant` reads a generated vault graph from `.note-assistant/graph.json`
and surfaces related notes for the current document directly inside Typora.

## Features

- show related notes for the current file
- show explicit wiki-links and backlinks from the generated graph
- open a related note directly from the panel
- insert selected wiki-links back into the current document
- rebuild the graph by running `node tools/note-assistant/build-graph.mjs`

## Expected Vault Side Files

This plugin expects the vault root to contain:

- `.note-assistant/graph.json`
- `tools/note-assistant/build-graph.mjs`

The current companion generator lives in your RooB vault and writes those files.

## Usage

- `Mod+;`: open Note Assistant
- Command: `Note Assistant: Open`
- Command: `Note Assistant: Rebuild Graph`
