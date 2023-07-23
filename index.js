"use strict";

import puppeteer from 'puppeteer';
import cheerio from 'cheerio';
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

let the_prompt;

await (async () => {
    return new Promise( resolve => {
        rl.question('What do you want to do? ', (prompt) => {
            the_prompt = prompt;
            rl.close();
            resolve();
        });
    } );
})();

const openaiApiKey = process.env.OPENAI_API_KEY;

String.prototype.explode = function (separator, limit)
{
    const array = this.split(separator);
    if (limit !== undefined && array.length >= limit)
    {
        array.push(array.splice(limit - 1).join(separator));
    }
    return array;
};

function ugly_chowder( html ) {
    html = html.replace(/<\//g, ' </');
    //console.log(html);
    const $ = cheerio.load( html );

    let simpledata = "";

    $('*').each((i, el) => {
        const tag = $(el).prop('name');

        if( tag === "h1" || tag === "h2" || tag === "h3" || tag === "p" || tag === "time" || tag === "article" || tag === "a" || tag === "ul" || tag === "ol" || tag === "li" ) {
            const text = $(el).text().replace(/[\s\n]+/g, ' ') + " ";
            const attrs = $(el).attr();
            const attrString = Object.keys(attrs).map(key => {
                return (key === "datetime" || key === "data-testid") ? ` ${key}="${attrs[key]}"` : '';
            }).join('');
            simpledata += ` <${tag}${attrString}>${text}`;
        }
    });

    return simpledata;
};

async function send_chat_message( message, context ) {
    let msg = {
        role: "user",
        content: message
    };

    //console.log( msg );

    let messages = [...context];
    messages.push( msg );

    //console.log( "Messages", messages );

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        "model": "gpt-4",
        "messages": messages
      })
    });

    const data = await response.json();

    //console.log(data);

    const text = data.choices[0].message.content.trim();

    //console.log("Response:" + text);

    return text;
}

async function sleep( ms ) {
    return new Promise( (resolve) => setTimeout( resolve, ms ) );
}

(async () => {
    const browser = await puppeteer.launch({
        headless: false
    });

    const page = await browser.newPage();

    let message = `You have been tasked with crawling the internet based on a task given by the user. You are connected to a Puppeteer script that can navigate to pages and list elements on the page. You shall only answer with a command to execute, nothing else. The commands will be described later. Some of them include "get_content" (run this every time you change the page), "list_links", "list_inputs", "type_text FIELD_NUMBER TEXT_TO_TYPE" and "goto_url URL". Answer only with one command at a time. You can answer "understood" to this message. No quotes are needed in the command arguments. You can also use the command "answer_user" with an answer as a string to give an answer to the user. Use this as the final response. The code [url] will be replaced with the current URL in the answer. Always start with the front page of a website.

If the content includes "Checking if the site connection is secure", you have arrived at a Cloudflare verification page. In this case, try to use a different website.

Remember that the user can not reply to you. All replies are automatic. Use only the given commands.

Your answer shall be based on the content on the website.`;

    let response = await send_chat_message(
        message,
        []
    );

    let context = [];

    context.push({
        role: "user",
        content: message
    });

    context.push({
        role: "assistant",
        content: response
    });

    message = `Task: ${the_prompt}\nWhat URL should I go to first? Please answer with "goto_url" followed by the URL. For example "goto_url https://google.com"`;

    response = await send_chat_message(
        message,
        context
    );

    context.push({
        role: "user",
        content: message
    });

    context.push({
        role: "assistant",
        content: response
    });

    await do_next_step( page, context, response, [], [], null );

    browser.close();
})();

function answer_user( message ) {
    console.log( "ChatGPT answered: " + message );
    process.exit(0);
}

async function list_links( page ) {
    const clickableElements = await page.$$('a, button');

    let links = [];
    let number = 0;

    for (const element of clickableElements) {
        number++;

        const href = await element.evaluate( (e) => e.href );
        let textContent = await element.evaluate( (e) => e.textContent );
        textContent = textContent.replace(/\n/g, '').trim();

        let text = "";

        if( textContent ) {
            text += textContent;
            if( href ) {
                text += " (" + href + ")";
            } else {
                text += " (button)";
            }

            if( ! links.find( elem => elem.text == text ) ) {
                let link = {
                    number: number,
                    element: element,
                    text: text
                }

                links.push( link );
            }
        }
    }

    return links;
}

async function list_inputs( page ) {
    const clickableElements = await page.$$('input[type=text], input[type=email], input[type=password], textarea');

    let inputs = [];
    let number = 0;

    for (const element of clickableElements) {
        number++;

        const name = await element.evaluate( (e) => e.name );
        const role = await element.evaluate( (e) => e.role );
        const placeholder = await element.evaluate( (e) => e.placeholder );
        const title = await element.evaluate( (e) => e.title );

        let text = "";

        if( name ) {
            text += name;
            if( role ) {
                text += " (role: " + role + ")";
            }
            if( placeholder ) {
                text += " (placeholder: " + placeholder + ")";
            }
            if( title ) {
                text += " (title: " + title + ")";
            }

            if( ! inputs.find( elem => elem.text == text ) ) {
                let input = {
                    number: number,
                    element: element,
                    text: text
                }

                inputs.push( input );
            }
        }
    }

    return inputs;
}

function list_for_gpt( list, what ) {
    let string_list = "";

    for (const element of list) {
        string_list += `${what} ${element.number}: ${element.text}\n`;
    }

    return string_list;
}

async function do_next_step( page, context, next_step, links, inputs, element ) {
    let message;
    let redacted_message;

    if( next_step.indexOf( "goto_url" ) === 0 ) {
        let parts = next_step.explode( "goto_url " );
        let parts2 = parts[1].explode( " " );
        let url = parts2[0];

        console.log( "Going to " + url );

        await page.goto( url, {
            waitUntil: "domcontentloaded"
        } );

        await sleep(3000);

        url = await page.url();

        message = `I'm on ${url} now. What should I do next? Please answer with "get_content" to get the text content of the page, "list_links" to list all the links on the page or "list_inputs" to list all the input fields on the page. Answer only with one command at a time.`
        redacted_message = message;
    } else if( next_step.indexOf( "list_links" ) === 0 ) {
        links = await list_links( page );
        let links_for_gpt = list_for_gpt( links, "Link" );
        if( links.length ) {
            message = `Here is the list of links on the page. Please answer with "list_inputs" if you want to see the list of the inputs instead or "click_link" followed by the number of the link, for example "click_link 5". Answer only with one command at a time.`;
        } else {
            message = "There are no links on the page.";
        }
        redacted_message = message;
        message += "\n\n" + links_for_gpt;
        if( links.length ) {
            redacted_message += "\n\n<list redacted>";
        }
    } else if( next_step.indexOf( "list_inputs" ) === 0 ) {
        inputs = await list_inputs( page );
        let inputs_for_gpt = list_for_gpt( inputs, "Input" );
        if( inputs.length ) {
            message = `Here is the list of inputs on the page. Please answer with "list_links" if you want to see the list of the links instead or "type_text" followed by the number of the input field and the text to input. For example "type_text 5 This is the search query". Answer only with one command at a time.`;
        } else {
            message = `There are no inputs on the page.`;
        }
        redacted_message = message;
        message += "\n\n" + inputs_for_gpt;
        if( inputs.length ) {
            redacted_message += "\n\n<list redacted>";
        }
    } else if( next_step.indexOf( "click_link" ) === 0 ) {
        let parts = next_step.explode( "click_link ", 2 );
        let parts2 = parts[1].explode( " ", 2 );
        let link_id = parts2[0];

        const link = links.find( elem => elem.number == link_id );

        try {
            element = link.element;

            console.log( `Clicking link "${link.text}"` );

            await element.click();
            await page.waitForNavigation({
                waitUntil: "domcontentloaded"
            });

            await sleep(3000);

            let url = await page.url();

            message = `OK. I clicked the link. I'm on ${url} now. What should I do next? Please answer with "list_links" to list all the links on the page or "list_inputs" to list all the input fields on the page. You can also run "get_content" to get the content of the page. Answer only with one command at a time.`
            redacted_message = message;
        } catch( error ) {
            links = await list_links( page );
            let links_for_gpt = list_for_gpt( links, "Link" );

            let link_text = link ? link.text : "";

            message = `Sorry, but link number ${link_id} (${link_text}) is not clickable, please select another link or another command. You can also try to go to the link URL directly with "goto_url". You can also run "get_content" to get the content of the page. Answer only with one command at a time. Here's the list of links again:`
            redacted_message = message;
            message += "\n\n" + links_for_gpt;
            redacted_message += "\n\n<list redacted>";
        }
    } else if( next_step.indexOf( "type_text" ) === 0 ) {
        let parts = next_step.explode( "type_text ", 2 );
        let parts2 = parts[1].explode( " ", 2 );
        let element_id = parts2[0];
        let text = parts2[1];

        try {
            const input = inputs.find( elem => elem.number == element_id );
            element = input.element;

            await element.type( text );

            console.log( `Typing "${text}" to an input field` );

            message = `OK. I typed "${text}" to the input box ${element_id}. What should I do next? Please answer with "send_form" or any of the above commands. Answer only with one command at a time.`;
            redacted_message = message;
        } catch( error ) {
            message = `Sorry, but there was an error with that command. Please try another command.`
            redacted_message = message;
        }
    } else if( next_step.indexOf( "send_form" ) === 0 ) {
        const form = await element.evaluateHandle(
            input => input.closest('form')
        );

        await form.evaluate(form => form.submit());
        await page.waitForNavigation({
            waitUntil: "domcontentloaded"
        });

        console.log( `Submitting form` );

        await sleep(3000);

        let url = await page.url();

        message = `OK. I sent the form. I'm on ${url} now. What should I do next? Please answer with "list_links" to list all the links on the page or "list_inputs" to list all the input fields on the page. You can also run "get_content" to get the content of the page. Answer only with one command at a time.`
        redacted_message = message;
    } else if( next_step.indexOf( "get_content" ) === 0 ) {
        const html = await page.evaluate(() => {
            return document.body.innerHTML;
        });

        const pageContent = ugly_chowder( html );

        message = `Here's the current page content. Please give the next command.`;
        redacted_message = message;
        message += "\n\n## CONTENT START ##\n" + pageContent + "\n## CONTENT END ##\n\nPlease give the next command or respond with 'answer_user YOUR_ANSWER_HERE' if the user's task has been completed.";
        redacted_message += "\n\n<content redacted>";
    } else if( next_step.indexOf( "answer_user" ) === 0 ) {
        let parts = next_step.explode( "answer_user ", 2 );
        let text = parts[1];

        let url = await page.url();
        text = text.replace( "[url]", url );
        text = text.replace( "[/url]", "" );

        console.log( "\nAnswer from ChatGPT: " + text );

        process.exit(0);
    } else {
        console.log( "unknown command!" );
        sleep( 10000 );
        process.exit(1);
    }

    next_step = await send_chat_message( message.substring( 0, 5000 ), context );

    context.push({
        role: "user",
        content: redacted_message
    });

    context.push({
        role: "assistant",
        content: next_step
    });

    await do_next_step( page, context, next_step, links, inputs, element );
}
