#!/bin/sh
# Downloads the source data (~600MB): English-Wiktionary Portuguese entries via
# kaikki.org, and an OpenSubtitles frequency list for European Portuguese.
set -eu
mkdir -p data
curl -fL -o data/pt.jsonl https://kaikki.org/dictionary/Portuguese/kaikki.org-dictionary-Portuguese.jsonl
curl -fL -o data/pt_freq.txt https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/pt/pt_50k.txt
