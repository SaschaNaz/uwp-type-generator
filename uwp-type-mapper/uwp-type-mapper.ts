﻿"use strict";

import parse from "./uwp-type-parser"
import {
TypeNotation,
FunctionTypeNotation,
FunctionParameter,
FunctionSignature,
DelegateTypeNotation,
EventTypeNotation
} from "./uwp-type-parser";
import {
ClassDescription,
TypeDescription,
TypeNameOrDescription
} from "../uwp-type-iterator/iterator";
import * as fspromise from "./fspromise"

main().catch((err) => console.error(err));


export interface FunctionDescription extends TypeDescription { __type: "function" | "callback"; __signatures: FunctionSignature[]; }


async function main() {
    let args = parseArgs();
    if (!args["-i"]) {
        throw new Error("Input iteration file path is not specified.");
    }
    if (!args["-o"]) {
        throw new Error("Output file path is not specified.");
    }

    console.log("Loading documentations...");
    let docs = await loadDocs("--force-reparse" in args)
    console.log("Loading iteration file...");
    let iterations = JSON.parse(await fspromise.readFile(args["-i"]));

    console.log("Mapping...");
    map(iterations, docs);

    console.log("Storing result file...");
    await fspromise.writeFile(args["-o"], JSON.stringify(iterations, null, 2));

    console.log("Finished.");
    process.exit();
}

function map(iteration: TypeDescription, docs: any) {
    for (let itemName in iteration) {
        if ((itemName as string).startsWith("__")) {
            continue;
        }

        let item = iteration[itemName] as TypeNameOrDescription;
        if (typeof item === "string") {
            if (item !== "unknown") {
                continue;
                // TODO: add descriptions!
            }
            if ((itemName as string).startsWith("on")) {
                itemName = (itemName as string).slice(2);
            }

            let fullName = `${iteration.__fullname}.${itemName}`.toLowerCase();

            let doc = docs[fullName] as TypeNotation;
            if (!doc) {
                continue;
            }

            switch (doc.type) {
                case "class":
                    break;
                case "enumeration":
                    break;
                case "namespace":
                    break;
                case "delegate":
                    break;
                case "function":
                    /*
                    TODO: interfaces from parser and iterator are too different, should be integrated
                    TypeDescription does not have members for function signatures
                    */
                    iteration[itemName] = {
                        __fullname: fullName,
                        __type: "function",
                        __description: doc.description,
                        __signatures: (doc as FunctionTypeNotation).signatures
                    } as FunctionDescription;
                    break;
                case "event":
                    /*
                    TODO: methods and onevents must be distingushable (by __type?)
                    Do FunctionDescription have to allow "function"|"?" <- What name? callback?
                     */
                    iteration[`on${itemName}`] = {
                        __fullname: fullName,
                        __type: "callback",
                        __description: doc.description,
                        __signatures: (doc as FunctionTypeNotation).signatures
                    } as FunctionDescription;
                    break;
                default: {
                    iteration[itemName] = {
                        __fullname: fullName,
                        __type: doc.type,
                        __description: doc.description
                    } as TypeDescription;
                    break;
                }
            }
        }
        else {
            let fullName = item.__fullname.toLowerCase();
            let doc = docs[fullName] as TypeNotation;
            if (doc) {
                item.__description = doc.description;
            }

            if (item.__type === "structure") {

                map(item, docs);
            }
            else if (item.__type === "class") {
                map(item, docs);

                if (hasEventCallback((item as ClassDescription).prototype)) {
                    (item as ClassDescription).__eventTarget = true;
                }
            }
        }
    }

    function hasEventCallback(iteration: TypeDescription) {
        for (let itemName in iteration) {
            if ((itemName as string).startsWith("__")) {
                continue;
            }
            let item = iteration[itemName] as TypeNameOrDescription;
            if ((item as TypeDescription).__type === "callback") {
                return true;
            }
        }
        return false;
    }
}

async function loadDocs(forceReparse?: boolean) {
    if (await fspromise.exists("built/typemap.json") && !forceReparse) {
        return JSON.parse(await fspromise.readFile("built/typemap.json"));
    }

    let result: any;
    try {
        result = await parse();
    }
    catch (err) {
        debugger;
        throw err;
    }
    if (!(await fspromise.exists("built"))) {
        await fspromise.makeDirectory("built");
    }
    await fspromise.writeFile("built/typemap.json", JSON.stringify(result, null, 2));
    return result;
}


function parseArgs() {
    let result: any = {};
    let proposedArgName: string;
    for (let arg of process.argv.slice(2)) {
        if (arg === "--force-reparse") {
            result[arg] = undefined;
            proposedArgName = undefined;
        }
        else if (arg === "-i" || arg === "-o") {
            proposedArgName = arg;
            result[arg] = undefined;
        }
        else {
            if (proposedArgName) {
                if (!arg.startsWith("-")) {
                    result[proposedArgName] = arg;
                }
                else {
                    throw new Error(`Unexpected argument after ${proposedArgName}: ${arg}`);
                }
            }
            else {
                throw new Error(`Unexpected argument: ${arg}`);
            }
            proposedArgName = undefined;
        }
    }
    return result;
}
