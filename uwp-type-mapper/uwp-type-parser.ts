"use strict";

import * as jsdom from "jsdom"
import * as fspromise from "./fspromise"
import * as dombox from "./dombox"

export interface TypeNotation {
    description: string;
    type: string;
}
export interface NamedTypeNotation extends TypeNotation {
    camelId: string;
}

export interface FunctionTypeNotation extends NamedTypeNotation {
    description: ""; // describe in signature object
    type: "function";
    signatures: FunctionSignature[];
}
export interface DelegateTypeNotation extends NamedTypeNotation {
    description: string;
    type: "delegate";
    signature: FunctionSignature;
}
export interface FunctionSignature {
    description: string;
    parameters: DescribedKeyTypePair[];
    typeParameters: string[];
    return: "instance" | TypeNotation;
    codeSnippet: string;
}
export interface DescribedKeyTypePair {
    description: string;
    type: string;
    key: string;
}

export interface EventTypeNotation extends NamedTypeNotation {
    type: "event";
    delegate: string;
}
export interface StructureTypeNotation extends NamedTypeNotation {
    type: "structure";
    members: DescribedKeyTypePair[];
}
export interface NamespaceDocumentNotation extends NamedTypeNotation {
    type: "namespace";
    members: {
        structures: string[];
        delegates: string[];
    }
}

export default async function parse() {
    return objectify(await parseAsMap());

    function objectify(map: Map<string, TypeNotation>) {
        let ob: any = {};
        let sortedEntries = Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
        for (let entry of sortedEntries) {
            ob[entry[0]] = entry[1];
        }
        return ob;
    }
}

async function parseAsMap() {
    /*
    TODO: This function should ultimately return fully formatted JSON object:
    {
        "documentType": "namespace",
        "syntax": {
            "codeSnippets": {
                "JavaScript": "...",
                "C++": "..."
            }
        },
        // ...
    }
    */
    let referenceMap = new Map<string, NamedTypeNotation>();

    let referencepath = "../referencedocs";
    let mshelppath = "ms-xhelp:///?Id=T%3a";
    let bracketRegex = /\[[^\[]*\]/;
    let parenthesisRegex = /\([^\(]*\)/;
    let whitespaceRepeatRegex = /\s{1,}/g;
    let eventListenerRegex = /\w+\.addEventListener\(\"(\w+)\"\, \w+\)/;
    let oneventRegex = /\w+\.on(\w+) =/;
    let genericsRegex = /<(.+)>$/;
    let files = await findAllHTMLFilePaths(referencepath);
    let skippedById: string[] = [];

    let i = 0;
    let length = files.length;
    for (let filepath of files) {
        i++;
        console.log(`Parsing ${filepath} (${(i / length * 100).toFixed(4)} %, skipping ${skippedById.length} out of ${length} docs)...`);
        try {
            let text = await fspromise.readFile(`${referencepath}/${filepath}`);
            let doc = jsdom.jsdom(text) as Document;
            let metaHelpId = doc.head.querySelector("meta[name=Microsoft\\.Help\\.Id]") as HTMLMetaElement;
            if (!metaHelpId) {
                continue;
            }
            let camelId = metaHelpId.content;
            let categoryJs = Array.from(doc.head.querySelectorAll("meta[name=Microsoft\\.Help\\.Category]")).filter((meta: HTMLMetaElement) => meta.content === "DevLang:javascript")[0];
            let startIndex = camelId.indexOf(":Windows");
            if (startIndex !== -1) {
                camelId = removeTick(camelId.slice(startIndex + 1));
            }
            else {
                skippedById.push(doc.title);
                continue;
            }
            if (!categoryJs || camelId.startsWith("Windows.UI.Xaml")) {
                skippedById.push(doc.title);
                continue; // Do not parse XAML API
            }
            // TODO: use target language meta tag? it can only be used with VS document
            let lowerCaseId = camelId.toLowerCase();
            let mainSection = doc.body.querySelector("div#mainSection") as HTMLDivElement;
            let mainContent = mainSection.textContent
            let description = getFirstParagraphText(mainSection.firstElementChild, "H2");
            let title = doc.body.querySelector("div.title").textContent.trim();

            if (title.endsWith(" class")) {
                // https://msdn.microsoft.com/en-us/library/windows/apps/windows.applicationmodel.background.smartcardtrigger.aspx

                referenceMap.set(lowerCaseId, {
                    description,
                    type: "class",
                    camelId
                });
            }
            else if (title.endsWith(" attribute")) {
                referenceMap.set(lowerCaseId, {
                    description,
                    type: "attribute",
                    camelId
                }); 
            }
            else if (title.endsWith(" enumeration")) {
                // Example URL: https://msdn.microsoft.com/en-us/library/windows/apps/windows.devices.pointofservice.posprintercartridgesensors.aspx

                referenceMap.set(lowerCaseId, {
                    description,
                    type: "enumeration",
                    camelId
                });

                let before = Array.from(mainSection.querySelectorAll("h2")).filter((h2) => h2.textContent.trim().startsWith("Members"))[0];
                let table = before.nextElementSibling.nextElementSibling as HTMLTableElement;

                if (table.tagName !== "TABLE") {
                    throw new Error("Unexpected enumeration document format");
                }

                let rows = Array.from(table.rows).slice(1) as HTMLTableRowElement[];

                for (let row of rows) {
                    let nameCol = row.children[0] as HTMLTableColElement;
                    let descCol = row.children[2] as HTMLTableColElement;
                    if (nameCol.children.length > 1) {
                        referenceMap.set(`${lowerCaseId}.${nameCol.children[1].textContent.trim().toLowerCase()}`, {
                            description: getFirstParagraphText(descCol.firstElementChild),
                            type: "Number",
                            camelId
                        });
                    }
                    else if (categoryJs) {
                        debugger;
                    }
                }

            }
            else if (title.endsWith(" namespace")) {
                let notation: NamespaceDocumentNotation = {
                    description,
                    type: "namespace",
                    members: {
                        structures: [],
                        delegates: []
                    },
                    camelId
                };
                let result = dombox.packByHeader(mainSection);
                
                if (result.subheaders["Members"]) {
                    let members = result.subheaders["Members"];
                    if (members.subheaders["Structures"]) {
                        let table = members.subheaders["Structures"].children[1] as HTMLTableElement;
                        if (table.tagName !== "TABLE") {
                            throw new Error(`Expected TABLE element but found ${table.tagName}`);
                        }
                        for (let item of scanMemberTableItems(table)) {
                            notation.members.structures.push(item.linkName);
                        }
                    }
                    if (members.subheaders["Delegates"]) {
                        let table = members.subheaders["Delegates"].children[1] as HTMLTableElement;
                        if (table.tagName !== "TABLE") {
                            throw new Error(`Expected TABLE element but found ${table.tagName}`);
                        }
                        for (let item of scanMemberTableItems(table)) {
                            notation.members.delegates.push(item.linkName);
                        }
                    }
                }
                else {
                    let table: HTMLTableElement;
                    if (result.subheaders["In this section"]) {
                        // Example URL: https://msdn.microsoft.com/en-us/library/windows/apps/windows.graphics.display.aspx
                        table = result.subheaders["In this section"].children[0] as HTMLTableElement;
                    }
                    else {
                        // Example URL: https://msdn.microsoft.com/en-us/library/windows/apps/windows.devices.pointofservice.aspx
                        table = result.children[result.children.length - 2] as HTMLTableElement;
                    }
                    if (table.tagName !== "TABLE") {
                        throw new Error(`Expected TABLE element but found ${table.tagName}`);
                    }
                    
                    for (let item of scanMemberTableItems(table)) {
                        if (item.textContent.endsWith(" structure")) {
                            notation.members.structures.push(item.linkName);
                        }
                        else if (item.textContent.endsWith(" delegate")) {
                            notation.members.delegates.push(item.linkName);
                        }
                    }
                }

                referenceMap.set(lowerCaseId, notation);
            }
            else if (title.endsWith(" property")) {
                // example URL: https://msdn.microsoft.com/en-us/library/windows/apps/windows.applicationmodel.background.smartcardtrigger.triggertype.aspx
                
                let before = Array.from(mainSection.querySelectorAll("h2")).filter((h2) => h2.textContent.trim().startsWith("Property value"))[0];
                let typeNotationParagraph = before.nextElementSibling;
                let type = exportJavaScriptTypeNotation(parseTypeNotationElement(typeNotationParagraph as HTMLParagraphElement));
                if (!type) {
                    // JS incompatble
                    throw new Error("Expected a JavaScript-compatible type but not found");
                }

                referenceMap.set(lowerCaseId, {
                    description,
                    type,
                    camelId
                });
            }
            else if (title.endsWith(" delegate")) {
                // example URL: https://msdn.microsoft.com/en-us/library/windows/apps/br206577.aspx, https://msdn.microsoft.com/en-us/library/windows/apps/br225997.aspx

                let signature = {
                    description: "",
                    parameters: undefined,
                    return: undefined
                } as FunctionSignature;

                let typeParameterMatch = title.slice(0, -9).match(genericsRegex);
                if (typeParameterMatch) { // generics
                    signature.typeParameters = typeParameterMatch[1].split(', ');
                }

                let before = Array.from(mainSection.querySelectorAll("h2")).filter((h2) => h2.textContent.trim().startsWith("Parameters"))[0];
                let parameterListElement = before.nextElementSibling as HTMLDListElement;
                signature.parameters = parseParameterList(parameterListElement);
                if (!signature.parameters) {
                    // JS incompatible
                    throw new Error("Expected a JavaScript-compatible type but not found");
                }

                (referenceMap as Map<string, DelegateTypeNotation>).set(lowerCaseId, {
                    description,
                    type: "delegate",
                    signature,
                    camelId
                });
            }
            else if (title.endsWith(" constructor")) {
                // example URL
                // no parameter:
                // https://msdn.microsoft.com/en-us/library/windows/apps/dn858104.aspx
                // one parameter:
                // https://msdn.microsoft.com/en-us/library/windows/apps/windows.applicationmodel.background.smartcardtrigger.smartcardtrigger.aspx
                // multiple parameters:
                // https://msdn.microsoft.com/en-us/library/windows/apps/dn631282.aspx

                
                let ctorIndex = lowerCaseId.indexOf(".#ctor");
                if (ctorIndex !== -1) {
                    lowerCaseId = `${lowerCaseId.slice(0, ctorIndex)}.constructor`;
                }
                else {
                    debugger;
                    throw new Error("Expected .ctor but not found");
                }

                let signature = {
                    description,
                    parameters: undefined,
                    return: "instance",
                    codeSnippet: undefined,
                    typeParameters: undefined
                } as FunctionSignature;

                let before = Array.from(mainSection.querySelectorAll("h2")).filter((h2) => h2.textContent.trim().startsWith("Parameters"))[0];
                let parameterListElement = before.nextElementSibling as HTMLDListElement;
                signature.parameters = parseParameterList(parameterListElement);
                if (!signature.parameters) {
                    // JS incompatible
                    throw new Error("Expected a JavaScript-compatible type but not found");
                }

                let notation: FunctionTypeNotation = referenceMap.get(lowerCaseId) as FunctionTypeNotation || {
                    description: "", // 
                    type: "function",
                    signatures: [],
                    camelId
                };
                notation.signatures.push(signature);

                referenceMap.set(lowerCaseId, notation);
                // Note: replace .#ctor(params) to .constructor
            }
            else if (title.endsWith(" method")) {
                let signature = {
                    description
                } as FunctionSignature;

                let result = dombox.packByHeader(mainSection);
                let syntaxHeader = result.subheaders["Syntax"];
                signature.codeSnippet = syntaxHeader.children.filter((element) => element.tagName === "CODESNIPPET" && element.getAttribute("language") === "JavaScript")[0].textContent;

                let parentheses = parenthesisRegex.exec(lowerCaseId);
                if (parentheses) {
                    lowerCaseId = lowerCaseId.slice(0, parentheses.index);
                } // may exist when with params, may not when without
                
                let parameterListElement = result.subheaders["Parameters"].children[0] as HTMLDListElement;
                signature.parameters = parseParameterList(parameterListElement);
                if (!signature.parameters) {
                    throw new Error("Expected a non-empty parameter list but not found");
                }

                let returnValueHeader = result.subheaders["Return value"];
                if (returnValueHeader) {
                    if (returnValueHeader.children.length > 0) {
                        let typeNotationElement = returnValueHeader.children[0] as HTMLParagraphElement;
                        let typeDescriptionElement = returnValueHeader.children[1];

                        let type = exportJavaScriptTypeNotation(parseTypeNotationElement(typeNotationElement));
                        if (!type) {
                            throw new Error("Expected a JavaScript-compatible type but not found");
                        }

                        signature.return = {
                            description: inline(typeDescriptionElement.textContent),
                            type
                        };
                    }
                    else {
                        // Some document has "Return value" header but does not have type notation
                        // https://msdn.microsoft.com/en-us/library/windows/apps/windows.applicationmodel.calls.phonecallhistorystore.getentryasync.aspx

                        signature.return = {
                            description: "",
                            type: "unknown"
                        };
                    }

                }

                let notation: FunctionTypeNotation = referenceMap.get(lowerCaseId) as FunctionTypeNotation || {
                    description: "", // 
                    type: "function",
                    signatures: [],
                    camelId
                };
                notation.signatures.push(signature);

                referenceMap.set(lowerCaseId, notation);
                // insert FunctionTypeNotation, and later check same key exists and append more signatures
            }
            else if (title.endsWith(" event")) {
                // Example URL: https://msdn.microsoft.com/en-us/library/windows/apps/windows.media.capture.core.variablephotosequencecapture.photocaptured.aspx

                let result = dombox.packByHeader(mainSection);

                let syntaxHeader = result.subheaders["Syntax"];
                let codeSnippetText = syntaxHeader.children.filter((element) => element.tagName === "CODESNIPPET" && element.getAttribute("language") === "JavaScript")[0].textContent;

                let eventListener = codeSnippetText.match(eventListenerRegex);
                let onevent = codeSnippetText.match(oneventRegex);
                
                let table = result.subheaders["Event information"].children[0] as HTMLTableElement;
                let rows = Array.from(table.rows) as HTMLTableRowElement[];
                if (rows.length > 1) {
                    throw new Error("Unexpected multiple table rows");
                }
                let typeNotationElement = rows[0].children[1];
                let delegate = exportJavaScriptTypeNotation(parseTypeNotationElement(typeNotationElement as HTMLTableColElement, true))
                if (!delegate) {
                    // JS compatibility is already checked above
                    throw new Error("Expected a JavaScript-compatible type but not found");
                }

                if (!eventListener || !onevent) {
                    throw new Error("Expected both event listener/onevent syntax but not found");
                }
                (referenceMap as Map<string, EventTypeNotation>).set(addOnPrefixOnHelpId(lowerCaseId), {
                    description,
                    type: "event",
                    delegate,
                    camelId
                });
            }
            else if (title.endsWith(" structure")) {
                /*
                There is (are): https://msdn.microsoft.com/en-us/library/windows/apps/windows.foundation.rect.aspx
                Parsing this will not be used on mapping, how can it be used to generate d.ts?
                Manually point and add them?
                
                Namespace should reference them so that mapper can know
                */
                let notation: StructureTypeNotation = {
                    description,
                    type: "structure",
                    members: [],
                    camelId
                };

                let membersHeader = Array.from(mainSection.querySelectorAll("h2")).filter((h2) => h2.textContent.trim().startsWith("Members"))[0];
                let tableOrList = membersHeader.nextElementSibling.nextElementSibling;
                let table: HTMLTableElement;
                if (tableOrList.tagName === "UL") {
                    // Rich structure (not in JS)
                    let before = Array.from(mainSection.querySelectorAll("h3")).filter((h3) => h3.textContent.trim().startsWith("Fields"))[0];
                    table = before.nextElementSibling.nextElementSibling as HTMLTableElement;
                }
                else if (tableOrList.tagName === "TABLE") {
                    table = tableOrList as HTMLTableElement;
                }
                else if (tableOrList.tagName !== "H2" /* next header */) {
                    throw new Error("Unexpected element type after Members header");
                }

                if (!table) {
                    // empty structure (will be written as 'any' later")
                    referenceMap.set(lowerCaseId, notation);
                    continue;
                }

                let rows = Array.from(table.rows).slice(1) as HTMLTableRowElement[];
                for (let row of rows) {
                    let memberName = parseMemberName(row.children[0] as HTMLTableColElement);
                    let memberType = exportJavaScriptTypeNotation(parseTypeNotationElement((row.children[1] as HTMLTableColElement).children[0] as HTMLParagraphElement, true));
                    let memberDescription = getFirstParagraphText(row.children[2].firstElementChild);
                    notation.members.push({
                        description: memberDescription,
                        key: memberName[1],
                        type: memberType
                    });
                }
                referenceMap.set(lowerCaseId, notation);
            }
            else if (title.endsWith(" interface")) {
                continue;
            }
            else if (title.endsWith(" constructors") || title.endsWith(" methods") || title === "Content Removed") {
                continue; // Do not parse meta pages
            }
            else {
                debugger;
                continue;
            }
        }
        catch (e) {
            throw new Error(`An error is thrown from ${filepath}: ${e.message}`);
        }
    }

    return referenceMap;


    function* scanMemberTableItems(table: HTMLTableElement) {
        let cellRows = dombox.packByCellMatrix(table as HTMLTableElement);
        if (cellRows.length < 1) {
            throw new Error(`Expected 2+ row table but found ${cellRows.length} rows.`);
        }

        cellRows = cellRows.slice(1);
        for (let row of cellRows) {
            let anchor = row[0].children[0] as HTMLAnchorElement;
            if (anchor.tagName === "P") {
                anchor = anchor.children[0] as HTMLAnchorElement;
            }
            if (anchor.tagName !== "A") {
                throw new Error(`Expected anchored reference but found ${anchor.tagName}`);
            }

            yield { textContent: row[0].textContent.trim(), linkName: removeTick(decodeURI(anchor.href.slice(mshelppath.length))) };
        }
    }

    function getFirstParagraphText(element: Element, beforeElement?: string) {
        // ignore '[text]' formed paragraphs
        // https://msdn.microsoft.com/en-us/library/windows/apps/windows.ui.input.inking.inkmanager.aspx
        let nextElement = element;
        while (nextElement && nextElement.tagName !== beforeElement) {
            if (nextElement.tagName === "P") {
                let text = nextElement.textContent.trim();
                if (!text.startsWith('[') || !text.endsWith(']')) {
                    return inline(nextElement.textContent.trim());
                }
            }
            nextElement = nextElement.nextElementSibling;
        }
    }
    function addOnPrefixOnHelpId(helpId: string) {
        let lastDotIndex = helpId.lastIndexOf(".");
        if (lastDotIndex === -1) {
            throw new Error("Incorrect help ID");
        }
        let base = helpId.slice(0, lastDotIndex);
        let shortName = helpId.slice(lastDotIndex + 1);

        return `${base}.on${shortName}`
    }

    function parseParameterList(listElement: HTMLDListElement): DescribedKeyTypePair[] {
        let parameters: DescribedKeyTypePair[] = [];
        let childItems = Array.from(listElement.children) as HTMLElement[];

        let parameterName: string;
        for (let child of childItems) {
            if (child.tagName === "DT") {
                parameterName = child.textContent.trim();
            }
            else if (child.tagName === "DD") {
                let parameterType = exportJavaScriptTypeNotation(parseTypeNotationElement(child.children[0] as HTMLParagraphElement));
                if (!parameterType) {
                    // No JS type
                    return;
                }

                let parameterDescription: string;
                if (child.children[1]) {
                    parameterDescription = inline(child.children[1].textContent);;
                }

                parameters.push({
                    description: parameterDescription,
                    type: parameterType,
                    key: parameterName
                });
            }
            else {
                debugger;
                throw new Error("Unexpected element");
            }
        }
        return parameters;
    }

    function parseTypeNotationElement(notationElement: HTMLElement, omitTypeIndication?: boolean): string | Map<string, string> {
        /*
        Expect "Type:"
        If sliced text still have non-whitespace text:
            If the text includes a bracket formed language indicator:
                Split it by indicator index
                Assume the result as type name + language indicator
            Else
                Assume the text as the only type name described
                Return the text
        While there is no next element:
            If the next element is anchor:
                Parse the reference as type name
            If the next element is <strong>:
                Assume it as type name
            If the next element is text:
                Try parsing it as language indicator
            Else:
                Break, assuming there is no more type description
        */
        // TODO: Fix "array of " problem https://msdn.microsoft.com/en-us/library/windows/apps/windows.media.protection.playready.nddownloadenginenotifier.ondatareceived.aspx
        let typeMap = new Map<string, string>();

        let node = notationElement.firstChild;
        
        let typeNotationPrefix: string;
        if (!omitTypeIndication) {
            if (isText(node) && node.textContent.indexOf("Type:") === 0) {
                let sliced = node.textContent.slice(5).trim();
                if (sliced === "array of") {
                    typeNotationPrefix = sliced;
                }
                else if (sliced.length > 0) {
                    let parsed = parseTypeNotationString(sliced);
                    if (!parsed.type) {
                        debugger;
                        throw new Error("Unexpected empty type name");
                    }

                    if (typeNotationPrefix) {
                        parsed.type = `${typeNotationPrefix} ${parsed.type}`;
                        typeNotationPrefix = undefined;
                    }
                    if (parsed.languages) {
                        for (let language of parsed.languages) {
                            typeMap.set(language, parsed.type);
                        }
                    }
                    else {
                        return parsed.type
                    }
                }
            }
            else {
                debugger;
                throw new Error("Incorrect type description");
            }
            node = node.nextSibling;
        }

        // https://msdn.microsoft.com/en-us/library/windows/apps/windows.system.memorymanager.appmemoryusagelimitchanging.aspx
        // TODO: use text node parser also in below code

        let proposedTypeName: string;
        let trimmedTextContent: string;
        while (node) {
            trimmedTextContent = node.textContent.trim();
            if (isElement(node)) {
                if (isAnchorElement(node)) {
                    proposedTypeName = removeTick(decodeURI(node.href.slice(mshelppath.length)));

                    let genericsMatch = node.textContent.trim().match(genericsRegex);
                    if (genericsMatch) {
                        proposedTypeName += genericsMatch[0];
                    }
                }
                else if (node.tagName === "STRONG" || node.tagName === "SPAN") {
                    proposedTypeName = trimmedTextContent
                }
                else if (node.tagName === "P") {
                    break;
                }
                else {
                    debugger;
                    throw new Error("Unexpected element");
                }
            }
            else if (isText(node) && trimmedTextContent.length > 0) {
                if (trimmedTextContent === "array of") {
                    typeNotationPrefix = trimmedTextContent;
                }
                else {
                    let parsed = parseTypeNotationString(trimmedTextContent);
                    if (parsed.type) {
                        proposedTypeName = parsed.type;
                    }
                    if (typeNotationPrefix) {
                        proposedTypeName = `${typeNotationPrefix} ${proposedTypeName}`;
                        typeNotationPrefix = undefined;
                    }
                    if (parsed.languages) {
                        for (let language of parsed.languages) {
                            typeMap.set(language, proposedTypeName);
                        }
                    }
                }
            }
            node = node.nextSibling;
        }
        if (typeMap.size === 0) {
            return proposedTypeName;
        }
        else {
            return typeMap;
        }

        interface TypeForLanguage {
            type?: string;
            languages?: string[];
        }
        function parseTypeNotationString(text: string) {
            /*
            "typeName [languageName]" -> { type: typeName, languages: [languageName] }
            "[languageName]" -> { languages: [languageName] }
            */
            let brackets = bracketRegex.exec(text);
            if (brackets) {
                let languages = parseLanguageIndicator(text.substr(brackets.index, brackets[0].length))
                // language name, type name
                return { type: text.slice(0, brackets.index).trim(), languages } as TypeForLanguage
            }
            else {
                return { type: text } as TypeForLanguage;
            }
        }

        function parseLanguageIndicator(text: string) {
            /* Expect potential slash-separated input */
            text = text.slice(1, -1);
            if (text.indexOf('/') !== -1) {
                return text.split('/');
            }
            else {
                return [text];
            }
        }
    }

    function parseMemberName(element: HTMLElement) {
        let names = Array.from(element.getElementsByTagName("strong"));
        if (names.length !== 2) {
            throw new Error("Unexpected name numbers");
        }
        return names.map((strong) => strong.textContent.trim());
    }

    function exportJavaScriptTypeNotation(notation: string | Map<string, string>) {
        if (typeof notation === "string") {
            return notation;
        }
        else {
            return notation.get("JavaScript");
        }
    }

    function inline(text: string) {
        return text.trim().replace(whitespaceRepeatRegex, " ");
    }
    function removeTick(typeName: string) {
        let backtickIndex = typeName.indexOf("`");
        if (backtickIndex !== -1) {
            typeName = typeName.slice(0, backtickIndex);
        }
        return typeName;
    }
}

function isText(node: Node): node is Text {
    return node.nodeType === 3;
}
function isElement(node: Node): node is Element {
    return node.nodeType === 1;
}
function isAnchorElement(element: Element): element is HTMLAnchorElement {
    return element.tagName === "A";
}

async function findAllHTMLFilePaths(directory: string) {
    let htmlFilePaths: string[] = [];
    await findHTMLFilePaths(directory);
    return htmlFilePaths;

    async function findHTMLFilePaths(directory: string) {
        let paths = await fspromise.readDirectory(directory);
        for (let path of paths) {
            let fullPath = `${directory}/${path}`;
            let stat = await fspromise.stat(fullPath);
            if (stat.isDirectory()) {
                await findHTMLFilePaths(fullPath);
            }
            else if (stat.isFile() && (path.endsWith(".htm") || path.endsWith(".html"))) {
                htmlFilePaths.push(fullPath);
            }
        }
    }
}