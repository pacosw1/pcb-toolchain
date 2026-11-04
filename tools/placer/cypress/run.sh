#!/bin/sh
# Runs inside iot-lab-cypress:cpu: CPU patches (patch.py), then Cypress.
set -e
cd /Cypress/install
python /work/patch.py
exec timeout 900 python dreamplace/Placer.py "$1"
