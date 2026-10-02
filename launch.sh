#!/usr/bin/env bash
cd "$(dirname "$0")"
setsid ./node_modules/.bin/electron . >/dev/null 2>&1 </dev/null &
