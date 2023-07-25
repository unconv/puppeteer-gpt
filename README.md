# Puppeteer-GPT

This script uses the ChatGPT API and Puppeteer to control Google Chrome in order to browse the internet. You can use it to get current information off the internet or accomplish tasks such as filling out forms.

It is currently not very capable, but for simple tasks it works, especially when instructed properly.

**NOTE: Browsing with GPT-4 can be quite expensive, since website source code has lots of tokens!**

## Installation

The code requires `puppeteer`, `cheerio` and `readline` NPM packages.

```console
$ npm install puppeteer cheerio readline
```

You need to set your OpenAI API key to the `OPENAI_API_KEY` environment variable

```console
$ export OPENAI_API_KEY=YOUR_API_KEY_HERE
```

## Usage

```console
$ node index.js
GPT: Hello! What would you like to browse today?
You: go to the unconventional coding channel on youtube

Going to https://www.youtube.com
Typing "Unconventional Coding" to an input field
Submitting form
Clicking link "Unconventional Coding"

GPT: Successfully navigated to the Unconventional Coding channel on YouTube.
You:
```

## Command line arguments

`--headless false`: Disable headless mode (show Chrome GUI)  
`--limit [LIMIT]`: Limit the maximum length of web page content to be passed to ChatGPT  
`--model [MODEL]`: Set the model to use (e.g. `gpt-4` or `gpt-3.5-turbo`)
