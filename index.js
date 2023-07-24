"use strict";

import puppeteer from 'puppeteer';
import cheerio from 'cheerio';
import readline from 'readline';

const context_length_limit = 6000;

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
        "messages": messages,
        "functions": [
            {
                "name": "goto_url",
                "description": "Go to a specific URL",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "The URL to go to"
                        }
                    }
                },
                "required": ["url"]
            },
            {
                "name": "list_links",
                "description": "Gets a list of the links on the current page",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "all": {
                            "type": "boolean",
                            "description": "Set this always to true"
                        }
                    }
                }
            },
            {
                "name": "list_inputs",
                "description": "Gets a list of the input fields on the current page",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "all": {
                            "type": "boolean",
                            "description": "Set this always to true"
                        }
                    }
                }
            },
            {
                "name": "click_link",
                "description": "Clicks a specific link on the page",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "link_id": {
                            "type": "number",
                            "description": "The ID of the link to click"
                        }
                    }
                }
            },
            {
                "name": "type_text",
                "description": "Types some text to an input field",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "input_id": {
                            "type": "number",
                            "description": "The ID of the input to type into"
                        },
                        "text": {
                            "type": "string",
                            "description": "The text to type"
                        }
                    }
                },
                "required": ["input_id", "text"]
            },
            {
                "name": "send_form",
                "description": "Sends the current form",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "current": {
                            "type": "boolean",
                            "description": "Set this to true always"
                        }
                    }
                },
                "required": ["current"]
            },
            {
                "name": "get_content",
                "description": "Gets the text content on the current page",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "current": {
                            "type": "boolean",
                            "description": "Set this to true always"
                        }
                    }
                }
            },
            {
                "name": "answer_user",
                "description": "Give an answer to the user and end the navigation",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "answer": {
                            "type": "string",
                            "description": "The response to the user"
                        }
                    }
                },
                "required": ["answer"]
            },
        ],
        "function_call": "auto"
      })
    }).catch(function(e) {
        console.log(e);
    });

    const data = await response.json();

    return data.choices[0].message;
}

async function sleep( ms ) {
    return new Promise( (resolve) => setTimeout( resolve, ms ) );
}

(async () => {
    const browser = await puppeteer.launch({
        headless: false
    });

    const page = await browser.newPage();

    let context = [
        {
            "role": "system",
            "content": `You have been tasked with crawling the internet based on a task given by the user. You are connected to a Puppeteer script that can navigate to pages and list elements on the page. You can also type into search boxes and other input fields and send forms. You can also click links on the page. You shall only answer with function calls. Start by navigating to the front page of a website. Don't go to a sub URL directly as the URL might not work. If you encounter a Page Not Found error, try another URL. Always read the contents of the page first when going to a new URL or clicking a link.`
        }
    ];

    let message = `Task: ${the_prompt}\nStart by going to a URL`;

    let response = await send_chat_message(
        message,
        context
    );

    context.push({
        role: "user",
        content: message
    });

    context.push(response);

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

    if( next_step.hasOwnProperty( "function_call" ) ) {
        let function_call = next_step.function_call;
        let function_name = function_call.name;
        let func_arguments = JSON.parse(function_call.arguments);

        if( function_name === "goto_url" ) {
            let url = func_arguments.url;

            console.log( "Going to " + url );

            await page.goto( url, {
                waitUntil: "domcontentloaded"
            } );

            await sleep(3000);

            url = await page.url();

            message = `I'm on ${url} now. What should I do next?`
            redacted_message = message;
        } else if( function_name === "list_links" ) {
            links = await list_links( page );
            let links_for_gpt = list_for_gpt( links, "Link" );
            if( links.length ) {
                message = `Here is the list of links on the page. Please answer with "list_inputs" if you want to see the list of the inputs instead or "click_link"`;
            } else {
                message = "There are no links on the page.";
            }
            redacted_message = message;
            message += "\n\n" + links_for_gpt;
            if( links.length ) {
                redacted_message += "\n\n<list redacted>";
            }
        } else if( function_name === "list_inputs" ) {
            inputs = await list_inputs( page );
            let inputs_for_gpt = list_for_gpt( inputs, "Input" );
            if( inputs.length ) {
                message = `Here is the list of inputs on the page. Please answer with "list_links" if you want to see the list of the links instead or "type_text"`;
            } else {
                message = `There are no inputs on the page.`;
            }
            redacted_message = message;
            message += "\n\n" + inputs_for_gpt;
            if( inputs.length ) {
                redacted_message += "\n\n<list redacted>";
            }
        } else if( function_name === "click_link" ) {
            let link_id = func_arguments.link_id;

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

                message = `OK. I clicked the link. I'm on ${url} now. What should I do next? Please answer with "list_links" to list all the links on the page or "list_inputs" to list all the input fields on the page. You can also run "get_content" to get the content of the page.`
                redacted_message = message;
            } catch( error ) {
                links = await list_links( page );
                let links_for_gpt = list_for_gpt( links, "Link" );

                let link_text = link ? link.text : "";

                message = `Sorry, but link number ${link_id} (${link_text}) is not clickable, please select another link or another command. You can also try to go to the link URL directly with "goto_url". You can also run "get_content" to get the content of the page. Here's the list of links again:`
                redacted_message = message;
                message += "\n\n" + links_for_gpt;
                redacted_message += "\n\n<list redacted>";
            }
        } else if( function_name === "type_text" ) {
            let element_id = func_arguments.input_id;
            let text = func_arguments.text;

            try {
                const input = inputs.find( elem => elem.number == element_id );
                element = input.element;

                await element.type( text );

                console.log( `Typing "${text}" to an input field` );

                message = `OK. I typed "${text}" to the input box ${element_id}. What should I do next? Please answer with "send_form" or any of the given function calls.`;
                redacted_message = message;
            } catch( error ) {
                message = `Sorry, but there was an error with that command. Please try another command.`
                redacted_message = message;
            }
        } else if( function_name === "send_form" ) {
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

            message = `OK. I sent the form. I'm on ${url} now. What should I do next? Please answer with "list_links" to list all the links on the page or "list_inputs" to list all the input fields on the page. You can also run "get_content" to get the content of the page.`
            redacted_message = message;
        } else if( function_name === "get_content" ) {
            const html = await page.evaluate(() => {
                return document.body.innerHTML;
            });

            const pageContent = ugly_chowder( html );

            message = `Here's the current page content. Please give the next command.`;
            redacted_message = message;
            message += "\n\n## CONTENT START ##\n" + pageContent + "\n## CONTENT END ##\n\nPlease give the next command or respond with 'answer_user' function if the user's task has been completed.";
            redacted_message += "\n\n<content redacted>";
        } else if( function_name === "answer_user" ) {
            let text = func_arguments.answer;

            let url = await page.url();
            text = text.replace( "[url]", url );
            text = text.replace( "[/url]", "" );

            console.log( "\nAnswer from ChatGPT: " + text );

            process.exit(0);
        } else {
            console.log( "unknown command!" );
            await sleep( 10000 );
            process.exit(1);
        }
    } else {
        console.log( "Response from ChatGPT: " + next_step.content.trim() );
        process.exit(0);
    }

    next_step = await send_chat_message( message.substring( 0, context_length_limit ), context );

    context.push({
        role: "user",
        content: redacted_message
    });

    context.push(next_step);

    await do_next_step( page, context, next_step, links, inputs, element );
}
