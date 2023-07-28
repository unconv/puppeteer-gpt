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

let navigation_timeout = 10000;
if( in_array( "--timeout", process.argv ) ) {
    navigation_timeout = parseInt( process.argv[parseInt(process.argv.indexOf("--timeout"))+1] );
}

let wait_until = "load";
if( in_array( "--waituntil", process.argv ) ) {
    wait_until = process.argv[parseInt(process.argv.indexOf("--waituntil"))+1];
}

let headless = true;
if( in_array( "--headless", process.argv ) ) {
    headless = (process.argv[parseInt(process.argv.indexOf("--headless"))+1] ?? "true") !== "false";
}

let task_prefix = "";
if( autopilot ) {
    task_prefix = "<!_TASK_!>";
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
        '#searchform',
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
    const $ = good_html( '<body>'+html+'</body>' );

    function traverse( element ) {
        let output = "";
        let children = element.children;

        if( $(element).is("h1, h2, h3, h4, h5, h6") ) {
            output += "<" + element.name + ">";
        }

        if( $(element).is("form") ) {
            output += "\n<" + element.name + ">\n";
        }

        if( $(element).is("div, section, main") ) {
            output += "\n";
        }

        let the_tag = make_tag( element );

        if( $(element).attr( "pgpt-id" ) ) {
            output += " " + (the_tag.tag ? the_tag.tag : "");
        } else if( element.type === "text" && ! $(element.parent).attr("pgpt-id") ) {
            output += " " + element.data.trim();
        }

        if( children ) {
            children.forEach( child => {
                output += traverse( child );
            } );
        }

        if( $(element).is("h1, h2, h3, h4, h5, h6") ) {
            output += "</" + element.name + ">";
        }

        if( $(element).is("form") ) {
            output += "\n</" + element.name + ">\n";
        }

        if( $(element).is("h1, h2, h3, h4, h5, h6, div, section, main") ) {
            output += "\n";
        }

        return output.replace(/[^\S\n]+/g, " ").replace(/ \n+/g, "\n").replace(/[\n]+/g, "\n");
    }

    return traverse( $('body')[0] );
};

function redact_messages( messages ) {
    let redacted_messages = [];
    let current_url = messages[messages.length-1].url;

    messages.forEach( message => {
        let msg = JSON.parse( JSON.stringify( message ) );

        if( msg.url != current_url ) {
            //msg.content = msg.redacted ?? msg.content ?? "";
        }

        delete msg.redacted;
        delete msg.url;

        redacted_messages.push( msg );
    } );

    if( debug ) {
        fs.writeFileSync(
            "context_redacted"+redacted_messages.length+".json",
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
            "description": "Create a plan to accomplish the given task. Summarize what the user's task is in a step by step manner. How would you browse the internet to accomplish the task. Start with 'I will'",
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
            "description": "Read the contents of a file that the user has provided to you",
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
            "description": "Goes to a specific URL and gets the content",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "The URL to go to (including protocol)"
                    },
                }
            },
            "required": ["url"]
        },
        {
            "name": "click_link",
            "description": "Clicks a link with the given pgpt_id on the page. Note that pgpt_id is required and you must use the corresponding pgpt-id attribute from the page content. Add the text of the link to confirm that you are clicking the right link.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "The text on the link you want to click"
                    },
                    "pgpt_id": {
                        "type": "number",
                        "description": "The pgpt-id of the link to click (from the page content)"
                    }
                }
            },
            "required": ["reason", "pgpt_id"]
        },
        {
            "name": "type_text",
            "description": "Types text to input fields and optionally submit the form",
            "parameters": {
                "type": "object",
                "properties": {
                    "form_data": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "pgpt_id": {
                                    "type": "number",
                                    "description": "The pgpt-id attribute of the input to type into (from the page content)"
                                },
                                "text": {
                                    "type": "string",
                                    "description": "The text to type"
                                }
                            }
                        }
                    },
                    "submit": {
                        "type": "boolean",
                        "description": "Whether to submit the form after filling the fields"
                    }
                }
            },
            "required": ["form_data", "submit"]
        },
        {
            "name": "answer_user",
            "description": "Give an answer to the user and end the navigation. Use when the given task has been completed. Summarize the relevant parts of the page content first and give an answer to the user based on that.",
            "parameters": {
                "type": "object",
                "properties": {
                    "summary": {
                        "type": "string",
                        "description": "A summary of the relevant parts of the page content that you base the answer on"
                    },
                    "answer": {
                        "type": "string",
                        "description": "The response to the user"
                    }
                }
            },
            "required": ["summary", "answer"]
        },
    ];

    if( functions !== null ) {
        definitions = definitions.filter( definition => {
            return in_array( definition.name, functions );
        } );
    }

    print( task_prefix + "Sending ChatGPT request..." );
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

let download_started = false;
let page_loaded = false;
let request_count = 0;
let request_block = false;
let response_count = 0;
let the_page;

async function start_browser() {
    if( the_page ) {
        return the_page;
    }

    const browser = await puppeteer.launch({
        headless: headless ? "new" : false,
    });

    const page = await browser.newPage();

    await page.setViewport( {
        width: 1200,
        height: 1200,
        deviceScaleFactor: 1,
    } );

    page.on( 'request', request => {
        if( request_block ) {
            if( request.isNavigationRequest() ) {
                request.respond({
                    status: 200,
                    contentType: 'application/octet-stream',
                    body: 'Dummy file to block navigation',
                });
            } else {
                request.continue();
            }
        }
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

    page.on( 'response', async response => {
        response_count++;
        let headers = response.headers();
        if( (headers['content-disposition']?.includes("attachment") || headers['content-length'] > 1024*1024 || headers['content-type'] === "application/octet-stream") ) {
            setTimeout( function() {
                if( response_count == 1 ) {
                    print("DOWNLOAD: A file download has been detected");
                    download_started = true;
                }
            }, 2000 );
        }
    } );

    the_page = page;

    return the_page;
}

(async () => {
    let context = [
        {
            "role": "system",
            "content": `
## OBJECTIVE ##
You have been tasked with crawling the internet based on a task given by the user. You are connected to a web browser which you can control via function calls to navigate to pages and list elements on the page. You can also type into search boxes and other input fields and send forms. You can also click links on the page. You will behave as a human browsing the web.

## NOTES ##
You will try to navigate directly to the most relevant web address. If you were given a URL, go to it directly. If you encounter a Page Not Found error, try another URL. If multiple URLs don't work, you are probably using an outdated version of the URL scheme of that website. In that case, try navigating to their front page and using their search bar or try navigating to the right place with links.

## WHEN TASK IS FINISHED ##
When you have executed all the operations needed for the original task, call answer_user to give a response to the user.`.trim()
        }
    ];

    let message = `Task: ${the_prompt}.`;
    let msg = {
        role: "user",
        content: message
    }

    let accept_plan = "n";
    let response;

    while( accept_plan !== "y" ) {
        response = await send_chat_message(
            msg,
            context,
            {
                "name": "make_plan",
                "arguments": ["plan"],
            }
        );

        let args = JSON.parse( response.function_call.arguments );

        print("\n## PLAN ##")
        print( args.plan );
        print("## PLAN ##\n")

        if( autopilot ) {
            accept_plan = "y";
        } else {
            accept_plan = await input("Do you want to continue with this plan? (y/n): ");
        }
    }

    context.push( msg );
    context.push( response );

    if( debug ) {
        fs.writeFileSync( "context.json", JSON.stringify( context, null, 2 ) );
    }

    const page = await start_browser();
    await do_next_step( page, context, response, [], null );

    browser.close();
})();

async function get_tabbable_elements( page, selector = "*" ) {
    let tabbable_elements = [];
    let skipped = [];
    let id = 0;

    await page.evaluate(() => {
        window.scrollBy(0, 1000);
    });

    let elements = await page.$$('input:not([type=hidden]):not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"]), select:not([disabled]), a[href]:not([href="javascript:void(0)"]):not([href="#"])');

    let limit = 400;

    for( const element of elements ) {
        if( --limit < 0 ) {
            break;
        }

        const next_tab = await get_next_tab( page, element, ++id, selector );

        if( next_tab !== false ) {
            tabbable_elements.push( next_tab );
        }
    }

    if( debug ) {
        fs.writeFileSync( "skipped.json", JSON.stringify( skipped, null, 2 ) );
    }

    if( debug ) {
        fs.writeFileSync( "tabbable.json", JSON.stringify( tabbable_elements, null, 2 ) );
    }

    return tabbable_elements;
}

async function get_next_tab( page, element, id, selector = "*" ) {
    let obj = await page.evaluate(async (element, id, selector) => {
        if( ! element.matches( selector ) ) {
            return false;
        }

        const tagName = element.tagName;

        if( tagName === "BODY" ) {
            return false;
        }

        let textContent = element.textContent.replace(/\s+/g, ' ').trim();

        if( textContent === "" && ! element.matches( "select, input, textarea" ) ) {
            return false;
        }

        element.classList.add("pgpt-element"+id);

        let role = element.role;
        let placeholder = element.placeholder;
        let title = element.title;
        let type = element.type;
        let href = element.href;
        let value = element.value;

        if( href && href.length > 32 ) {
            href = href.substring( 0, 32 ) + "[..]";
        }

        if( placeholder && placeholder.length > 32 ) {
            placeholder = placeholder.substring( 0, 32 ) + "[..]";
        }

        if( ! textContent && title && title.length > 32 ) {
            title = title.substring( 0, 32 ) + "[..]";
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
    }, element, id, selector);

    if( ! obj ) {
        return false;
    }

    const visible = await page.evaluate( async (id) => {
        const element = document.querySelector(".pgpt-element"+id);

        if( ! element ) {
            return false;
        }

        const visibility = element.style.visibility;
        const display = element.style.display;
        const clip = element.style.clip;
        const rect = element.getBoundingClientRect();

        return (
            visibility !== 'hidden' &&
            display !== 'none' &&
            rect.width != 0 &&
            rect.height != 0 &&
            clip !== "rect(1px, 1px, 1px, 1px)" &&
            clip !== "rect(0px, 0px, 0px, 0px)"
        );
    }, id );

    if( ! visible ) {
        return false;
    } else {
        await page.evaluate( async (id) => {
            const element = document.querySelector( ".pgpt-element"+id );
            element.setAttribute( "pgpt-id", id );
            element.style.border="1px solid red";
        }, id );
    }

    return obj;
}

function make_tag(element) {
    const $ = cheerio;

    let textContent = $(element).text().replace(/\s+/g, ' ').trim();
    let placeholder = $(element).attr( "placeholder" );
    let tagName = element.name;
    let title = $(element).attr( "title" );
    let value = $(element).attr( "value" );
    let role = $(element).attr( "role" );
    let type = $(element).attr( "type" );
    let href = $(element).attr( "href" );
    let pgpt_id = $(element).attr( "pgpt-id" );

    if( href && href.length > 32 ) {
        href = href.substring( 0, 32 ) + "[..]";
    }

    if( placeholder && placeholder.length > 32 ) {
        placeholder = placeholder.substring( 0, 32 ) + "[..]";
    }

    if( title && title.length > 32) {
        title = title.substring( 0, 32 ) + "[..]";
    }

    if( textContent && textContent.length > 200 ) {
        textContent = textContent.substring( 0, 200 ) + "[..]";
    }

    let tag = `<${tagName}`;

    if( href ) { tag += ` href="${href}"`; }
    if( type ) { tag += ` type="${type}"`; }
    if( placeholder ) { tag += ` placeholder="${placeholder}"`; }
    if( title ) { tag += ` title="${title}"`; }
    if( role ) { tag += ` role="${role}"`; }
    if( value ) { tag += ` value="${value}"`; }
    if( pgpt_id ) { tag += ` pgpt-id="${pgpt_id}"`; }

    tag += `>`;

    let obj = {
        tag: tag,
    };

    if( textContent ) {
        obj.text = textContent;
        obj.tag += `${textContent}</${tagName}>`;
    }

    return obj;
}

function check_download_error( error ) {
    if( error instanceof Error && error.message.startsWith('net::ERR_ABORTED') ) {
        return "NOTICE: The connection was aborted. If you clicked on a download link, the file has been downloaded to the default Chrome downloads location.";
    } else if( debug ) {
        print( error );
    }

    return null;
}

async function get_page_content( page ) {
    const title = await page.evaluate(() => {
        return document.title;
    });

    const html = await page.evaluate(() => {
        return document.body.innerHTML;
    });

    return "## START OF PAGE CONTENT ##\nTitle: " + title + "\n\n" + ugly_chowder( html ) + "\n## END OF PAGE CONTENT ##";
}

async function wait_for_navigation( page ) {
    try {
        await page.waitForNavigation({
            timeout: navigation_timeout,
            waitUntil: wait_until,
        });
    } catch( error ) {
        print("NOTICE: Giving up on waiting for navigation");
    }
}

async function do_next_step( page, context, next_step, links_and_inputs, element ) {
    let message;
    let msg;
    let no_content = false;

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

        if( function_name === "make_plan" ) {
            message = "OK. Please continue according to the plan";
        } else if( function_name === "read_file" ) {
            let filename = func_arguments.filename;

            if( autopilot || await input( "\nGPT: I want to read the file " + filename + "\nDo you allow this? (y/n): " ) == "y" ) {
                print()
                print( task_prefix + "Reading file " + filename );

                if( fs.existsSync( filename ) ) {
                    let file_data = fs.readFileSync( filename, 'utf-8' );
                    file_data = file_data.substring( 0, context_length_limit );
                    message = file_data;
                } else {
                    message = "ERROR: That file does not exist";
                }
            } else {
                print()
                message = "ERROR: You are not allowed to read this file";
            }
        } else if( function_name === "goto_url" ) {
            let url = func_arguments.url;

            print( task_prefix + "Going to " + url );

            try {
                await page.goto( url, {
                    waitUntil: wait_until
                } );

                url = await page.url();

                message = `You are now on ${url}`;
            } catch( error ) {
                message = check_download_error( error );
                message = message ?? "There was an error going to the URL";
            }

            print( task_prefix + "Scraping page..." );
            links_and_inputs = await get_tabbable_elements( page );
        } else if( function_name === "click_link" ) {
            let link_id = func_arguments.pgpt_id;
            let link_text = func_arguments.text;

            if( ! link_id ) {
                message = "ERROR: Missing parameter pgpt_id";
            } else if( ! link_text ) {
                message = "";
                context.pop();
                msg = {
                    "role": "user",
                    "content": "Please the correct link on the page. Remember to set both the text and the pgpt_id parameter."
                }
            } else {
                const link = links_and_inputs.find( elem => elem && elem.id == link_id );

                try {
                    print( task_prefix + `Clicking link "${link.text}"` );

                    request_count = 0;
                    response_count = 0;
                    download_started = false;

                    if( ! page.$(".pgpt-element" + link_id) ) {
                        throw new Error( "Element not found" );
                    }

                    page.click( ".pgpt-element" + link_id );

                    await wait_for_navigation(page);

                    let url = await page.url();

                    if( download_started ) {
                        download_started = false;
                        message = "Link clicked and file download started successfully!";
                        no_content = true;
                    } else {
                        message = "Link clicked! You are now on " + url;
                    }
                } catch( error ) {
                    if( debug ) {
                        print( error );
                    }
                    if( error instanceof TimeoutError ) {
                        message = "NOTICE: The click did not cause a navigation.";
                    } else {
                        let link_text = link ? link.text : "";

                        message = `Sorry, but link number ${link_id} (${link_text}) is not clickable, please select another link or another command. You can also try to go to the link URL directly with "goto_url".`
                    }
                }
            }

            print( task_prefix + "Scraping page..." );
            links_and_inputs = await get_tabbable_elements( page );
        } else if( function_name === "type_text" ) {
            let form_data = func_arguments.form_data;
            let prev_input;

            for( let data of form_data ) {
                let element_id = data.pgpt_id;
                let text = data.text;

                message = "";

                try {
                    element = await page.$(".pgpt-element"+element_id);

                    if( ! prev_input ) {
                        prev_input = element;
                    }

                    const name = await element.evaluate( el => {
                        return el.getAttribute( "name" );
                    } );

                    const type = await element.evaluate( el => {
                        return el.getAttribute( "type" );
                    } );

                    const tagName = await element.evaluate( el => {
                        return el.tagName;
                    } );

                    // ChatGPT sometimes tries to type empty string
                    // to buttons to click them
                    if( tagName === "BUTTON" || type === "submit" || type === "button" ) {
                        func_arguments.submit = true;
                    } else {
                        prev_input = element;
                        await element.type( text );
                        let sanitized = text.replace("\n", " ");
                        print( task_prefix + `Typing "${sanitized}" to ${name}` );
                        message += `Typed "${text}" to input field "${name}"\n`;
                    }
                } catch( error ) {
                    if( debug ) {
                        print(error);
                    }
                    message += `Error typing "${text}" to input field ID ${data.element_id}\n`;
                }
            }

            if( func_arguments.submit !== false ) {
                print( task_prefix + `Submitting form` );

                try {
                    const form = await prev_input.evaluateHandle(
                        input => input.closest('form')
                    );

                    await form.evaluate(form => form.submit());
                    await wait_for_navigation(page)

                    let url = await page.url();

                    message += `Form sent! You are now on ${url}\n`
                } catch( error ) {
                    if( debug ) {
                        print( error );
                    }
                    print( task_prefix + `Error submitting form` );
                    message += "There was an error submitting the form.\n";
                }

                print( task_prefix + "Scraping page..." );
                links_and_inputs = await get_tabbable_elements( page );
            }
        } else if( function_name === "answer_user" ) {
            let text = func_arguments.answer;

            if( ! text ) {
                text = func_arguments.summary;
            }

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
        msg = msg ?? {
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

    if( no_content !== true ) {
        const page_content = await get_page_content( page );
        msg.content += "\n\n" + page_content.substring( 0, context_length_limit );
    }

    msg.url = await page.url();

    next_step = await send_chat_message( msg, context );

    msg.content = message,

    context.push( msg );
    context.push( next_step );

    if( debug ) {
        fs.writeFileSync( "context.json", JSON.stringify( context, null, 2 ) );
    }

    await do_next_step( page, context, next_step, links_and_inputs, element );
}
