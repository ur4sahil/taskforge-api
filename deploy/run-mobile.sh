#!/usr/bin/env bash
# Sequential mobile QA crawls (iPhone 14 Pro on WebKit, then Pixel 7 on Chromium), fully detached.
cd ~/taskforge-qa
: > crawl-iphone.log; : > crawl-pixel.log
(TF_DEVICE=iphone nohup node qa-crawl.mjs > crawl-iphone.log 2>&1; TF_DEVICE=pixel nohup node qa-crawl.mjs > crawl-pixel.log 2>&1) > /dev/null 2>&1 &
disown
sleep 2; echo "procs: $(pgrep -fc "[n]ode qa-crawl")"
