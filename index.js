"use strict";

import fs from 'fs';
import puppeteer, { TimeoutError } from 'puppeteer';
import cheerio from 'cheerio';
import readline from 'readline';

const debug = in_array( "--debug", process.argv );
const autopilot = in_array( "--autopilot", process.argv ); // for gpt-autopilot

let model = "gpt-3.5-turbo-16k";
if( in_array( "--model", process.argv ) ) {
    model = process.argv[parseInt(process.argv.indexOf("--model"))+1];
}

let context_length_limit = 15000;
if( in_array( "--limit", process.argv ) ) {
    context_length_limit = process.argv[parseInt(process.argv.indexOf("--limit"))+1];
}

let navigation_timeout = 5000;
if( in_array( "--timeout", process.argv ) ) {
    navigation_timeout = parseInt( process.argv[parseInt(process.argv.indexOf("--timeout"))+1] );
}

let wait_until = "networkidle0";
if( in_array( "--waituntil", process.argv ) ) {
    wait_until = process.argv[parseInt(process.argv.indexOf("--waituntil"))+1];
}

let headless = true;
if( in_array( "--headless", process.argv ) ) {
    headless = (process.argv[parseInt(process.argv.indexOf("--headless"))+1] ?? "true") !== "false";
}

let token_usage = {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
};

function get_token_price( model, direction ) {
    let token_price_input = 0.0
    let token_price_output = 0.0

    if( model.indexOf("gpt-4-32k") === 0 ) {
        token_price_input = 0.06 / 1000
        token_price_output = 0.12 / 1000
    } else if( model.indexOf("gpt-4") === 0 ) {
        token_price_input = 0.03 / 1000
        token_price_output = 0.06 / 1000
    } else if( model.indexOf("gpt-3.5-turbo-16k") === 0 ) {
        token_price_input = 0.003 / 1000
        token_price_output = 0.004 / 1000
    } else if( model.indexOf("gpt-3.5-turbo") === 0 ) {
        token_price_input = 0.0015 / 1000
        token_price_output = 0.002 / 1000
    }

    if( direction == "input" ) {
        return token_price_input
    } else {
        return token_price_output
    }
}

function token_cost( prompt_tokens, completion_tokens, model ) {
    let prompt_price = get_token_price( model, "input" );
    let completion_price = get_token_price( model, "output" );

    return prompt_tokens * prompt_price + completion_tokens * completion_price;
}

function round( number, decimals ) {
    return number.toFixed( decimals );
}

function print_current_cost() {
    let cost = token_cost(
        token_usage.prompt_tokens,
        token_usage.completion_tokens,
        model,
    );

    print( "Current cost: " + round( cost, 2 ) + " USD (" + token_usage.total_tokens + " tokens)" );
}

function print( message = "" ) {
    console.log( message );
}

function in_array( element, array ) {
    for( let i = 0; i < array.length; i++ ) {
        if( array[i] == element ) {
            return true;
        }
    }

    return false;
}

async function input( text ) {
    let the_prompt;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    await (async () => {
        return new Promise( resolve => {
            rl.question( text, (prompt) => {
                the_prompt = prompt;
                rl.close();
                resolve();
            } );
        } );
    })();

    return the_prompt;
}

print( "Using model: " + model + "\n" )

let the_prompt;
if( autopilot ) {
    the_prompt = await input( "<!_PROMPT_!>\n" );
} else {
    the_prompt = await input( "GPT: Hello! What would you like to browse today?\nYou: " )
    print();
}

const openaiApiKey = process.env.OPENAI_API_KEY;

function good_html( html ) {
    html = html.replace(/<\//g, ' </');
    let $ = cheerio.load( html );

    $("script, style").remove();

    let important = [
        'main',
        '[role="main"]',
        '#bodyContent',
        '#search',
        '.kp-header',
    ];

    // move important content to top
    important.forEach((im) => {
        $(im).each((i, el) => {
            $(el).prependTo("body");
        });
    });

    return $;
}

function ugly_chowder( html ) {
    let $ = good_html( html );

    let simpledata = "";

    const important = [
        ".kp-header",
        "#search",
    ];

    // always get textcontent of important stuff
    important.forEach((im) => {
        $(im).each((i, el) => {
            simpledata += $(el).text() + "\n\n";
        });
    });

    const allowed_tags = [
        "h1",
        "h2",
        "h3",
        "p",
        "time",
        "article",
        "a",
        "ul",
        "ol",
        "li",
    ];

    const allowed_attrs = [
        "datetime",
        "data-testid",
    ];

    $('*').each((i, el) => {
        const tag = $(el).prop('name');

        if( in_array( tag, allowed_tags ) ) {
            const text = $(el).text().replace(/[\s\n]+/g, ' ') + " ";
            const attrs = $(el).attr();
            const attrString = Object.keys(attrs).map(key => {
                return in_array( key, allowed_attrs ) ? ` ${key}="${attrs[key]}"` : '';
            }).join('');
            simpledata += ` <${tag}${attrString}>${text}`;
        }
    });

    return simpledata;
};

function redact_messages( messages ) {
    let redacted_messages = [];
    let current_url = messages[messages.length-1].url;

    messages.forEach( message => {
        let msg = JSON.parse( JSON.stringify( message ) );

        if( msg.url != current_url ) {
            msg.content = msg.redacted ?? msg.content ?? "";
        }

        delete msg.redacted;
        delete msg.url;

        redacted_messages.push( msg );
    } );

    if( debug ) {
        fs.writeFileSync(
            "context_redacted.json",
            JSON.stringify( redacted_messages, null, 2 )
        );
    }

    return redacted_messages;
}

async function send_chat_message(
    message,
    context,
    function_call = "auto",
    functions = null
) {
    let messages = [...context];
    messages.push( message );

    if( debug ) {
        fs.writeFileSync( "context.json", JSON.stringify( messages, null, 2 ) );
    }

    let definitions = [
        {
            "name": "make_plan",
            "description": "Create a plan to accomplish the given task",
            "parameters": {
                "type": "object",
                "properties": {
                    "plan": {
                        "type": "string",
                        "description": "The step by step plan on how you will navigate the internet and what you will do"
                    }
                }
            },
            "required": ["plan"]
        },
        {
            "name": "read_file",
            "description": "Read the contents of a file",
            "parameters": {
                "type": "object",
                "properties": {
                    "filename": {
                        "type": "string",
                        "description": "The filename to read, e.g. file.txt or path/to/file.txt"
                    }
                }
            },
            "required": ["filename"]
        },
        {
            "name": "goto_url",
            "description": "Goes to a specific URL",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to go to (including protocol)"
                    },
                    "reasoning": {
                        "type": "string",
                        "description": "Explanation on why you would like to run this function and what exactly you will do."
                    },
                }
            },
            "required": ["url", "reasoning"]
        },
        {
            "name": "list_links",
            "description": "Gets a list of the links on the current page",
            "parameters": {
                "type": "object",
                "properties": {
                    "reasoning": {
                        "type": "string",
                        "description": "Explanation on why you would like to run this function."
                    }
                }
            },
            "required": ["reasoning"]
        },
        {
            "name": "list_inputs",
            "description": "Gets a list of the input fields on the current page",
            "parameters": {
                "type": "object",
                "properties": {
                    "reasoning": {
                        "type": "string",
                        "description": "Explanation on why you would like to run this function."
                    }
                }
            },
            "required": ["reasoning"]
        },
        {
            "name": "click_link",
            "description": "Clicks a specific link on the page (list_links must be called first)",
            "parameters": {
                "type": "object",
                "properties": {
                    "reasoning": {
                        "type": "string",
                        "description": "Explanation on why you would like to run this function."
                    },
                    "link_id": {
                        "type": "number",
                        "description": "The ID number of the link to click"
                    }
                }
            },
            "required": ["reasoning", "link_id"]
        },
        {
            "name": "type_text",
            "description": "Types some text to an input field (list_inputs must be called first)",
            "parameters": {
                "type": "object",
                "properties": {
                    "reasoning": {
                        "type": "string",
                        "description": "Explanation on why you would like to run this function."
                    },
                    "input_id": {
                        "type": "number",
                        "description": "The ID number of the input to type into"
                    },
                    "text": {
                        "type": "string",
                        "description": "The text to type"
                    }
                }
            },
            "required": ["reasoning", "input_id", "text"]
        },
        {
            "name": "send_form",
            "description": "Sends the form that the last filled input field belongs to",
            "parameters": {
                "type": "object",
                "properties": {
                    "reasoning": {
                        "type": "string",
                        "description": "Explanation on why you would like to run this function."
                    }
                }
            },
            "required": ["reasoning"]
        },
        {
            "name": "get_content",
            "description": "Gets the text content on the current page",
            "parameters": {
                "type": "object",
                "properties": {
                    "reasoning": {
                        "type": "string",
                        "description": "Explanation on why you would like to run this function."
                    }
                }
            },
            "required": ["reasoning"]
        },
        {
            "name": "answer_user",
            "description": "Give an answer to the user and end the navigation. Use when the given task has been completed",
            "parameters": {
                "type": "object",
                "properties": {
                    "reasoning": {
                        "type": "string",
                        "description": "Explain your chain of thought for figuring out the answer"
                    },
                    "answer": {
                        "type": "string",
                        "description": "The response to the user"
                    }
                }
            },
            "required": ["answer"]
        },
        {
            "name": "list_relevant_parts",
            "description": "List relevant parts of the page content",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "A summary of the relevant information"
                    }
                }
            },
            "required": ["summary"]
        },
    ];

    if( functions !== null ) {
        definitions = definitions.filter( definition => {
            return in_array( definition.name, functions );
        } );
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${openaiApiKey}`
      },
      body: JSON.stringify({
        "model": model,
        "messages": redact_messages( messages ),
        "functions": definitions,
        "function_call": function_call ?? "auto"
      })
    }).catch(function(e) {
        print(e);
    });

    const data = await response.json();

    if( data.choices === undefined ) {
        print( data );
    }

    // fix JSON arguments
    if( data.choices[0].message.hasOwnProperty("function_call") ) {
        data.choices[0].message.function_call.arguments = data.choices[0].message.function_call.arguments.replace('"\n  "', '",\n  "');
    }

    token_usage.completion_tokens += data.usage.completion_tokens;
    token_usage.prompt_tokens += data.usage.prompt_tokens;
    token_usage.total_tokens += data.usage.total_tokens;

    let cost = token_cost(
        data.usage.prompt_tokens,
        data.usage.completion_tokens,
        model,
    );

    if( cost > 0.09 ) {
        print( "Cost: +" + round( cost, 2 ) + " USD (+" + data.usage.total_tokens + " tokens)" );
    }

    if( autopilot ) {
        print( "<!_TOKENS_!>" + data.usage.prompt_tokens + " " + data.usage.completion_tokens + " " + data.usage.total_tokens )
    }

    return data.choices[0].message;
}

async function sleep( ms, print_debug = true ) {
    if( debug && print_debug ) {
        print( "Sleeping " + ms + " ms..." );
    }
    return new Promise( (resolve) => setTimeout( resolve, ms ) );
}

let page_loaded = false;
let request_count = 0;

(async () => {
    const browser = await puppeteer.launch({
        headless: headless ? "new" : false,
        defaultViewport: {
            width: 1920,
            height: 1200,
        }
    });

    const page = await browser.newPage();

    page.on( 'request', () => {
        request_count++;
    } );

    page.on( 'load', () => {
        if( debug ) {
            print( "Page loaded" );
        }
        page_loaded = true;
    } );

    page.on( 'framenavigated', async frame => {
        if( frame === page.mainFrame() ) {
            if( frame._lifecycleEvents.length < 5 ) {
                if( page_loaded && debug ) {
                    print( "Loading page..." );
                }
                page_loaded = false;
            } else {
                await sleep( 500 );
            }
        }
    } );

    let context = [
        {
            "role": "system",
            "content": `You have been tasked with crawling the internet based on a task given by the user. You are connected to a Puppeteer script that can navigate to pages and list elements on the page. You can also type into search boxes and other input fields and send forms. You can also click links on the page. If you encounter a Page Not Found error, try another URL or try going to the front page of the site and navigating from there. If the page doesn't have the content you want, try clicking on a link or navigating to a completely different page. You must list the links or the inputs first before you can click on them or input into them.`
        }
    ];

    let message = `Task: ${the_prompt}. Start by navigating to a website`;
    let msg = {
        role: "user",
        content: message
    }

    let response = await send_chat_message(
        msg,
        context,
        {
            "name": "make_plan",
            "arguments": ["plan"],
        }
    );

    context.push(msg);

    context.push(response);

    if( debug ) {
        fs.writeFileSync( "context.json", JSON.stringify( context, null, 2 ) );
    }

    await do_next_step( page, context, response, [], [], null );

    browser.close();
})();

async function get_tabbable_elements( page, selector = "*" ) {
    let tabbable_elements = [];
    let id = 0;

    tabbable_elements.push(
        await get_next_tab( page, ++id, selector )
    );

    await page.evaluate(() => {
        document.activeElement.classList.add( "pgpt-first-element" );
    });

    tabbable_elements.push(
        await get_next_tab( page, ++id, selector )
    );

    const limit = 200;
    let elements_found = 0;

    while( elements_found < limit ) {
        elements_found++;

        const first_element = await page.evaluate(() => {
            return document.activeElement.classList.contains( "pgpt-first-element" );
        });

        if( first_element ) {
            break
        }

        const next_tab = await get_next_tab( page, ++id, selector );

        if( next_tab !== false ) {
            tabbable_elements.push( next_tab );
        } else {
            id--;
        }
    }

    return tabbable_elements.filter( (element) => {
        return element;
    } );
}

async function get_next_tab( page, id, selector = "*" ) {
    await page.keyboard.press("Tab");

    await sleep( 5, false );

    let element = await page.evaluateHandle(() => {
        return document.activeElement;
    })

    let obj = await page.evaluate(async (id, selector) => {
        if( ! document.activeElement.matches( selector ) ) {
            return false;
        }

        const tagName = document.activeElement.tagName;

        if( tagName === "BODY" ) {
            return false;
        }

        let textContent = document.activeElement.textContent.replace(/\s+/g, ' ').trim();

        if( textContent === "" && ! document.activeElement.matches( "select, input, textarea" ) ) {
            return false;
        }

        let role = document.activeElement.role;
        let placeholder = document.activeElement.placeholder;
        let title = document.activeElement.title;
        let type = document.activeElement.type;
        let href = document.activeElement.href;
        let value = document.activeElement.value;

        if( href && href.length > 42 ) {
            href = href.substring( 0, 42 ) + "[..]";
        }

        if( placeholder && placeholder.length > 42 ) {
            placeholder = placeholder.substring( 0, 42 ) + "[..]";
        }

        if( title && title.length > 42 ) {
            title = title.substring( 0, 42 ) + "[..]";
        }

        if( textContent && textContent.length > 200 ) {
            textContent = textContent.substring( 0, 200 ) + "[..]";
        }

        let tag = `<${tagName}`;

        if( href ) { tag += ` href="${href}"` };
        if( type ) { tag += ` type="${type}"` };
        if( placeholder ) { tag += ` placeholder="${placeholder}"` };
        if( title ) { tag += ` title="${title}"` };
        if( role ) { tag += ` role="${role}"` };
        if( value ) { tag += ` value="${value}"` };

        tag += `>`;

        let obj = {
            tag: tag,
            id: id,
        };

        if( textContent ) {
            obj.text = textContent;
        }

        return obj;
    }, id, selector);

    if( ! obj ) {
        return false;
    }

    obj.element = element;

    await page.keyboard.down("Shift");
    await page.keyboard.press("Tab");
    await page.keyboard.up("Shift");

    const visible = await page.evaluate( async (element) => {
        const styles = window.getComputedStyle( element );
        const visibility = styles.getPropertyValue( 'visibility' );
        const display = styles.getPropertyValue( 'display' );
        const clip = styles.getPropertyValue( 'clip' );
        const rect = element.getBoundingClientRect();

        return (
            visibility !== 'hidden' &&
            display !== 'none' &&
            rect.width != 0 &&
            rect.height != 0 &&
            clip !== "rect(1px, 1px, 1px, 1px)" &&
            clip !== "rect(0px, 0px, 0px, 0px)"
        );
    }, element );

    await page.keyboard.press("Tab");

    if( ! visible ) {
        return false;
    }

    return obj;
}

async function list_links( page ) {
    return get_tabbable_elements( page, 'a, button, [role="tab"]' );

    const clickableElements = await page.$$('a, button, [role="tab"]');

    let links = [];
    let nav_links = [];
    let important_links = [];
    let number = 0;

    let important = [
        '#search',
    ];

    for (const element of clickableElements) {
        number++;

        const href = await element.evaluate( (e) => e.href );
        let textContent = await element.evaluate( (e) => e.textContent );
        textContent = textContent.replace(/\n/g, '').trim();

        let duplicate_link = links.find( elem => {
            elem.text == textContent && href && elem.href == href
        } );

        if( textContent && ! duplicate_link ) {
            let link = {
                id: number,
                element: element,
                text: textContent,
                url: href,
            }

            const is_in_nav = await element.evaluate( (node) => {
                const closest_nav = node.closest('nav');
                return closest_nav !== null;
            } );

            let is_important = false;

            for( const selector of important ) {
                const in_selector = await element.evaluate( (node, selector) => {
                    const closest_element = node.closest( selector );
                    return closest_element !== null;
                }, selector );

                if( in_selector ) {
                    is_important = true;
                }
            };

            if( is_important ) {
                important_links.push( link );
            } else if( is_in_nav ) {
                nav_links.push( link );
            } else {
                links.push( link );
            }
        }
    }

    return [...important_links, ...links, ...nav_links];
}

async function list_inputs( page ) {
    return get_tabbable_elements( page, 'select, input, textarea' );

    const clickableElements = await page.$$('input, textarea');

    let inputs = [];
    let number = 0;

    for (const element of clickableElements) {
        const type = await element.evaluate( (e) => e.type );
        const name = await element.evaluate( (e) => e.name );
        const role = await element.evaluate( (e) => e.role );
        const placeholder = await element.evaluate( (e) => e.placeholder );
        const title = await element.evaluate( (e) => e.title );

        let text = "";

        if( name && type != "hidden" && type != "file" ) {
            number++;
            text += name;

            let input = {
                text: text,
                type: type,
                id: number,
                element: element,
            }

            if( role ) { input.role = role; }
            if( placeholder ) { input.placeholder = placeholder; }
            if( title ) { input.title = title; }

            inputs.push( input );
        }
    }

    return inputs;
}

function list_for_gpt( list, what ) {
    let formatted = JSON.parse( JSON.stringify( list ) );

    for( const element of formatted ) {
        delete element.element;
    }

    return JSON.stringify( formatted, null, 2 );
}

function check_download_error( error ) {
    if( error instanceof Error && error.message.startsWith('net::ERR_ABORTED') ) {
        return "NOTICE: The connection was aborted. If you clicked on a download link, the file has been downloaded to the default Chrome downloads location.";
    } else if( debug ) {
        print( error );
    }

    return null;
}

async function wait_for_navigation() {
    await sleep( 500 );

    if( page_loaded === true ) {
        return false;
    }

    let wait_time = 0;
    while( page_loaded === false && wait_time < navigation_timeout ) {
        await sleep( 500 );
        wait_time += 500;
    }

    return true;
}

async function do_next_step( page, context, next_step, links, inputs, element ) {
    let message;
    let msg;
    let redacted_message;

    let task_prefix = "";
    if( autopilot ) {
        task_prefix = "<!_TASK_!>";
    }

    if( next_step.hasOwnProperty( "function_call" ) ) {
        let function_call = next_step.function_call;
        let function_name = function_call.name;
        let func_arguments;

        try {
            func_arguments = JSON.parse(function_call.arguments);
        } catch( e ) {
            if( function_name === "answer_user" ) {
                func_arguments = {
                    "answer": function_call.arguments
                }
            }
        }

        if( function_name === "list_relevant_parts" ) {
            message = "OK. Continue by answering the user or by other functions";
        } else if( function_name === "make_plan" ) {
            message = "OK. Please continue according to the plan";
        } else if( function_name === "read_file" ) {
            let filename = func_arguments.filename;

            print( task_prefix + "Reading file " + filename );

            let file_data = fs.readFileSync( filename, 'utf-8' );
            file_data = file_data.substring( 0, context_length_limit );

            message = file_data;
        } else if( function_name === "goto_url" ) {
            let url = func_arguments.url;

            print( task_prefix + "Going to " + url );

            try {
                await page.goto( url, {
                    waitUntil: wait_until
                } );

                await sleep( 2000 );

                url = await page.url();

                links = false;

                message = `Navigated to ${url}`
            } catch( error ) {
                message = check_download_error( error );
                message = message ?? "There was an error going to the URL";
            }
        } else if( function_name === "list_links" ) {
            print( task_prefix + "Listing links" );

            let url = await page.url();

            links = await list_links( page );
            let links_for_gpt = list_for_gpt( links, "Link" );
            if( links.length ) {
                message = `Here is the list of links on the page. Call "click_link" with the ID number of a link if you want to click it.\n\nRemember your task: ${the_prompt}\n\nRemember you have already navigated to ${url}`;
            } else {
                message = "There are no links on the page.";
            }
            redacted_message = message;
            message += "\n\n" + links_for_gpt;
            if( links.length ) {
                redacted_message += "\n\n<list redacted>";
            }
        } else if( function_name === "list_inputs" ) {
            print( task_prefix + "Listing inputs" );

            inputs = await list_inputs( page );
            let inputs_for_gpt = list_for_gpt( inputs, "input" );
            if( inputs.length ) {
                message = `Here is the list of inputs on the page. Please call "type_text" with the ID number of the input field and the text to type, if you want to fill in the form.`;
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

            if( links === false ) {
                message = "ERROR: You must first list the links to get the IDs";
            } else {
                const link = links.find( elem => elem.id == link_id );

                try {
                    element = link.element;

                    print( task_prefix + `Clicking link "${link.text}"` );

                    request_count = 0;
                    await element.click();
                    await sleep( 2000 );

                    if( await wait_for_navigation() ) {
                        await sleep( 2000 );
                        let url = await page.url();
                        message = `Navigated to ${url}`
                    } else {
                        message = "Link successfully clicked!";
                        if( request_count > 0 ) {
                            message += " If this was a download link, the download has been started to the Chrome default downloads folder.";
                        }
                    }

                    links = false;
                } catch( error ) {
                    if( error instanceof TimeoutError ) {
                        message = "NOTICE: The click did not cause a navigation. If it was a download link, the file has been downloaded to the default Chrome download location.";
                    } else {
                        links = await list_links( page );
                        let links_for_gpt = list_for_gpt( links, "link" );

                        let link_text = link ? link.text : "";

                        message = `Sorry, but link number ${link_id} (${link_text}) is not clickable, please select another link or another command. You can also try to go to the link URL directly with "goto_url". You can also call "get_content" to get the content of the page.`
                        redacted_message = message;
                        message += "\n\n" + links_for_gpt;
                        redacted_message += "\n\n<list redacted>";
                    }
                }
            }
        } else if( function_name === "type_text" ) {
            let element_id = func_arguments.input_id;
            let text = func_arguments.text;

            try {
                const input = inputs.find( elem => elem.id == element_id );
                const name = await input.element.evaluate( (e) => e.name );
                element = input.element;

                await element.type( text );

                let sanitized = text.replace("\n", " ");
                print( task_prefix + `Typing "${sanitized}" to ${name}` );

                message = `OK. I typed "${text}" to the input box "${name}". What should I do next? Please call "send_form" if you want to submit the form.`;
            } catch( error ) {
                if( debug ) {
                    print(error);
                }
                message = `Sorry, but there was an error with that command. Please try another command.`
            }
        } else if( function_name === "send_form" ) {
            print( task_prefix + `Submitting form` );

            try {
                const form = await element.evaluateHandle(
                    input => input.closest('form')
                );

                await form.evaluate(form => form.submit());

                let navigated = "No navigation occured.";
                if( await wait_for_navigation() ) {
                    await sleep( 3000 );
                    navigated = "";
                }

                let url = await page.url();

                links = false;

                message = `OK. I sent the form. I'm on ${url} now. ${navigated}`
            } catch( error ) {
                if( debug ) {
                    print( error );
                }
                print( task_prefix + `Error submitting form` );
                message = "There was an error submitting the form.";
            }
        } else if( function_name === "get_content" ) {
            links = false;

            print( task_prefix + "Getting page content" );

            const title = await page.evaluate(() => {
                return document.title;
            });

            const html = await page.evaluate(() => {
                return document.body.innerHTML;
            });

            const page_content = ugly_chowder( html );

            message = `Here's the current page content.`;
            redacted_message = message;
            message += `\n\n## CONTENT START ##\nTitle: ${title}\n\n${page_content}\n## CONTENT END ##\n\nIn your next response, list all parts of the above content that are relevant to the original prompt:\n\n${the_prompt}`;
            redacted_message += "\n\n<content redacted>";
        } else if( function_name === "answer_user" ) {
            let text = func_arguments.answer;

            print_current_cost();

            if( autopilot ) {
                message = await input( "<!_RESPONSE_!>" + JSON.stringify(text) + "\n" );
            } else {
                message = await input( "\nGPT: " + text + "\nYou: " );
            }

            print();
        } else {
            message = "That is an unknown function. Please call another one";
        }

        message = message.substring( 0, context_length_limit );
        msg = {
            "role": "function",
            "name": function_name,
            "content": JSON.stringify({
                "status": "OK",
                "message": message,
            }),
        }
    } else {
        print_current_cost();

        let next_content = next_step.content.trim();

        if( next_content === "") {
            next_content = "<empty response>";
        }

        if( autopilot ) {
            message = await input( "<!_RESPONSE_!>" + JSON.stringify(next_content) + "\n" );
        } else {
            message = await input( "GPT: " + next_content + "\nYou: " );
            print();
        }

        msg = {
            "role": "user",
            "content": message,
        }
    }

    msg.redacted = redacted_message;
    msg.url = await page.url();

    next_step = await send_chat_message( msg, context );

    context.push( msg );
    context.push( next_step );

    if( debug ) {
        fs.writeFileSync( "context.json", JSON.stringify( context, null, 2 ) );
    }

    await do_next_step( page, context, next_step, links, inputs, element );
}
