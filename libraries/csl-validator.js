var CSLValidator = (function() {

    //to access Ace
    var editor;

    //to access URL parameters
    var uri;

    //required for highlighting in ace editor
    var Range;

    //keep track of source code highlighting, so we can remove prior highlighting
    //when selecting a different error
    var marker;

    var loadButton;
    var validateButton;
    var saveButton;
    var submitButton;

    //keep track of how much time validator.nu is taking
    var responseTimer;
    var responseMaxTime = 6000; //in milliseconds
    var responseStartTime;
    var responseEndTime;

    //cache for editor content and errors
    var pageCache = {};

    //Empty editor
    var emptyAceDoc;

    //Schema state labels
    var schemaLabel = {
        '1.1mlz1': 'Juris-M',
        '1.0.1': 'CSL 1.0.1',
        '1.0': 'CSL 1.0',
        '0.8.1': 'CSL 0.8.1'
    }

    function parseXML (xmlStr) {
        if (window.DOMParser) {
            var parser=new DOMParser();
            xmlDoc=parser.parseFromString(xmlStr,"text/xml");
        } else { // code for IE
            var xmlDoc=new ActiveXObject("Microsoft.XMLDOM");
            xmlDoc.async=false;
            xmlDoc.loadXML(xmlStr);
        }
        return xmlDoc;
    }
    
    var JSONWalker = function() {}

    JSONWalker.prototype.walktojson = function(doc) {
        var elem = doc.getElementsByTagName('style')[0];
        var obj = this.walktoobject(elem);
        var json = JSON.stringify(obj);
        return json;
    }

    JSONWalker.prototype.walktoobject = function(elem) {
        var obj = {};
        obj.name = elem.nodeName;
        obj.attrs = {};
        if (elem.attributes) {
            for (var i=0,ilen=elem.attributes.length;i<ilen;i++) {
                var attr = elem.attributes[i];
                obj.attrs[attr.name] = attr.value;
            }
        }
        obj.children = [];
        if (elem.childNodes.length === 0 && elem.tagName === 'term') {
            obj.children = [''];
        }
        for (var i=0,ilen=elem.childNodes.length;i<ilen;i++) {
            var child = elem.childNodes[i];
            if (child.nodeName === '#comment') {
                continue;
            } else if (child.nodeName === '#text') {
                if (elem.childNodes.length === 1 && ['term', 'single', 'multiple'].indexOf(child.nodeName) > -1) {
                    obj.children.push(child.textContent)
                }
            } else {
                obj.children.push(this.walktoobject(child));
            }
        }
        return obj;
    }
    jsonWalker = new JSONWalker();

    var init = function() {
        //Initialize URI.js
        uri = new URI();

        //Initialize page cache
        $('.source-input').each(function(){
            var key = this.getAttribute('id');
            pageCache[key] = {
                aceDocument: null,
                load: null,
                validate: null,
                save: null,
                submit: null,
                sourceTab: null,
                errorTab:null,
                errorBanner:null,
                errors: null,
                schema: null,
                urlQuery: null
            }
        });

        //Create range for Ace editor
        Range = ace.require("ace/range").Range;

        //Create an empty session for source modes not yet loaded
        emptyAceDoc = ace.createEditSession('')

        //Disable at init (may be reenabled by URL load)
        $("#tabs").tabs("disable", "#errors");

        //Initialize Ladda buttons
        loadButton = Ladda.create(document.querySelector('#load-source'));
        validateButton = Ladda.create(document.querySelector('#validate'));
        validateButton.disable();
        saveButton = Ladda.create(document.querySelector('#save'));
        saveButton.disable();
        submitButton = Ladda.create(document.querySelector('#submit'));
        submitButton.disable();

        //wake up load button on change, if content present
        $('#file-input').on('change', function(event) {
            if (this.value) {
                loadButton.enable();
                validateButton.enable();
            } else {
                loadButton.disable();
                validateButton.enable();
            }
        });

        //set schema-version if specified
        if (uri.hasQuery('version')) {
            var setSchemaVersion = uri.query(true)['version'];
            $('#schema-version').attr('value', setSchemaVersion);
            if (schemaLabel[setSchemaVersion]) {
                $('#schema-name').attr('value', schemaLabel[setSchemaVersion]);
            }
        }

        //run validation if URL parameters includes URL
        if (uri.hasQuery('url')) {
            var setURL = uri.query(true)['url'];
            $("#url-input").val(setURL);
            $('#url-source-remover').show();
            setView(null,'editor');
            $('.source-input').hide();
            $('#url-source').show();
            if ($('#url-input').val()) {
                $('#url-source-remover').show();
                $('#url-source-remover button:first-child').prop('disabled', false);
            }
            $('#source-method').attr('value', 'url-source');
            loadSource();
        } else {
            $('#url-input').val('');
            setView(null,'main');
        }

        //validate on button click
        $("#validate").click(reValidate);
        $("#load-source").click(loadSource);

        //save on button click
        $("#save").click(saveFile);

        //load when pressing Enter in URL text field with content
        //reset when pressing Enter in URL text field with no content
        //reset when pressing Backspace in URL text field with no content
        $('#url-input, #search-input').keyup(function(event) {
            var id = this.getAttribute('id').replace(/-.*/,'');
            if (event.keyCode == 13) {
                event.preventDefault();
                if (!this.value) {
                    loadButton.enable();
                    validateButton.disable();
                    $('#' + id + '-source-remover').hide();
                }
            }
            if (event.keyCode === 8) {
                event.preventDefault();
                if (!this.value) {
                    loadButton.enable();
                    validateButton.disable();
                    $('#' + id + '-source-remover').hide();
                }
            }
            if (this.value) {
                $('#' + id + '-source-remover').show();
                loadButton.enable();
            }
        });

        $('#url-source-remover, #search-source-remover').click(function(event) {
            var id = this.getAttribute('id').replace(/-.*/,'');
            loadButton.disable();
            $('#' + id + '-input').val('');
            $('#' + id + '-source-remover').hide();
        });

        $("#source-method").click(function(event){
            var target = $(event.target);
            if (target.is('A')) {
                event.preventDefault();
                var oldSourceMethod = $('#source-method').attr('value');
                if (oldSourceMethod !== target.attr('value')) {
                    var sourceMethod = target.attr('value');
                    $('#source-method').attr('value',sourceMethod);
                    $('.source-input').hide();
                    $('.source-input-remover').hide();
                    if (sourceMethod === 'file-source') {
                        //$('#file-source').attr('style', 'border:none;padding:0px;margin:0px;display:inline;');
                        $('#file-source').show();
                    } else if (sourceMethod === 'search-source') {
                        $('#search-source').show();
                        if ($('#search-input').val()) {
                            $('#search-source-remover').show();
                            $('#search-source-remover button:first-child').prop('disabled', false);
                        } else {
                            $('#search-source-remover').hide();
                        }
                    } else if (sourceMethod === 'url-source') {
                        $('#url-source').show();
                        if ($('#url-input').val()) {
                            $('#url-source-remover').show();
                            $('#url-source-remover button:first-child').prop('disabled', false);
                        } else {
                            $('#url-source-remover').hide();
                        }
                    }
                    // Save state:
                    // * Editor
                    // * Buttons (load/validate/save/submit)
                    // * Errors (nodes)
                    // * Schema selection
                    // * TAB STATES
                    if (oldSourceMethod) {
                        var old = oldSourceMethod;
                        pageCache[old].load = $('#load-source').prop('disabled');
                        pageCache[old].validate = $('#validate').prop('disabled');
                        pageCache[old].save = $('#save').prop('disabled');
                        pageCache[old].submit = $('#submit').prop('disabled');
                        pageCache[old].errors = document.getElementById('error-list').cloneNode(true);
                        var errorBanner = document.getElementById('error-banner');
                        if (errorBanner) {
                            pageCache[old].errorBanner = errorBanner.cloneNode(true);
                            errorBanner.parentNode.removeChild(errorBanner);
                        } else {
                            errorBanner = null;
                        }
                        pageCache[old].schema = $('#schema-version').attr('value');
                        pageCache[old].sourceTab = $('#source-tab').parent().attr('aria-disabled');
                        pageCache[old].errorsTab = $('#errors-tab').parent().attr('aria-disabled');
                        // Not sure how we can use this - resetting the document query
                        // would reload the page and blast the editor content ...
                        if (uri.hasQuery('url')) {
                            pageCache[old].urlQuery = uri.query(true)['url'];
                        } else {
                            pageCache[old].urlQuery = false;
                        }
                    }
                    if (pageCache[sourceMethod].aceDocument) {
                        var novo = sourceMethod;
                        pageCache[novo].load ? loadButton.disable() : loadButton.enable();
                        pageCache[novo].validate ? validateButton.disable() : validateButton.enable();
                        pageCache[novo].save ? saveButton.disable() : saveButton.enable();
                        pageCache[novo].submit ? submitButton.disable() : submitButton.enable();
                        $('#tabs').tabs('enable');
                        pageCache[novo].sourceTab ? $('#tabs').tabs('disable', '#source') : null;
                        pageCache[novo].errorsTab ? $('#tabs').tabs('disable', '#errors') : null;
                        if (pageCache[novo].errorBanner) {
                            var sourceTitle = document.getElementById('source-title');
                            if (sourceTitle) {
                                sourceTitle.parentNode.appendChild(pageCache[novo].errorBanner);
                            }
                        }
                        var errorList = document.getElementById('error-list');
                        errorList.parentNode.replaceChild(pageCache[novo].errors,errorList);
                        $('#schema-version').attr('value', pageCache[novo].schema);
                        $('#schema-name').attr('value', schemaLabel[pageCache[novo].schema]);
                        editor.setSession(pageCache[novo].aceDocument);
                    } else {
                        loadButton.disable();
                        validateButton.disable();
                        saveButton.disable();
                        submitButton.disable();
                        $('#tabs').tabs('enable');
                        $('#error-list').empty();
                        if (editor) {
                            editor.setSession(emptyAceDoc);
                        }
                    }
                }
            }
        });

        $("#schema-version").click(function(event){
            var target = $(event.target);
            if (target.is('A')) {
                event.preventDefault();
                var oldSchemaVersion = $("#schema-version").attr('value');
                if (oldSchemaVersion !== target.attr('value')) {
                    $('#schema-name').attr('value', target.text());
                    $('#schema-version').attr('value',target.attr('value'));
                }
            }
        });

        $('#errors-tab').click(function(){
            setBoxHeight(['error-list']);
        });
        
        $(window).bind('resize',function(){
            setBoxHeight(['source', 'errors']);
            setBoxHeight(['source-code']);
        });
        setBoxHeight(['source']);
        setBoxHeight(['source-code']);
    };

    function loadValidateButton(state, noAction) {
        if (isFromLoad) {
            loadButton[state]();
        } else {
            validateButton[state]();
        }
        if ('stop' === state && isFromLoad) {
            if (!noAction) {
                loadButton.disable();
            }
        }
    }

    /* code originally for scrolling
     * Ahnsirk Dasarp
     * http://stackoverflow.com/questions/5007530/how-do-i-scroll-to-an-element-using-javascript
     */
    function setBoxHeight(lst) {
        for (var i=0,ilen=lst.length;i<ilen;i++) {
            var obj = document.getElementById(lst[i]);
            if (!obj) return;
            var offset = 0;
            if (lst[i] === 'error-list') {
                offset = 8;
            }
            var curtop = 0;
            var curleft = 0;
            if (obj.offsetParent) {
                do {
                    curtop += obj.offsetTop;
                    curleft += obj.offsetLeft;
                } while (obj = obj.offsetParent);
                var docViewHeight = document.documentElement.clientHeight;
                var boxHeight = (docViewHeight - curtop - 4);
                for (var i=0,ilen=lst.length;i<ilen;i++) {
                    var elem = document.getElementById(lst[i]);
                    if (elem) {
                        elem.style['min-height'] = ((boxHeight - offset) + 'px');
                        elem.style['max-height'] = ((boxHeight - offset) + 'px');
                    }
                }
            }
        }
    }

    function setView(event,name) {
        if (event) {
            event.preventDefault();
        };
        $('.action-view').attr('style', 'display:none;');
        $('#' + name + '-view').attr('style', 'display:block;');
        var titles = {
            main: 'Juris-M: Welcome',
            editor: 'Style Manager'
        }
        if (titles[name]) {
            document.title = titles[name];
        }

        if (name === 'editor') {
            // This doesn't work when small display is set to main,
            // then resized larger, then editor selected.
            setBoxHeight(['tabs']);
            if (editor) {
                setBoxHeight(['source']);
                setBoxHeight(['source-code']);
                editor.renderer.updateFull();
            }
        }
    }

    var sourceMethodFunc = null;

    function getSchemaURL () {
        var cslVersion = $('#schema-version').attr('value');
        var schemaURL = '';
        if (cslVersion.indexOf("mlz") > -1) {
            schemaURL = "https://raw.githubusercontent.com/fbennett/schema/v" + cslVersion + "/csl-mlz.rnc";
        } else {
            schemaURL = "https://raw.githubusercontent.com/citation-style-language/schema/v" + cslVersion + "/csl.rnc";
        }
        //schemaURL += " " + "https://raw.githubusercontent.com/citation-style-language/schema/master/csl.sch";
        return schemaURL;
    }

    function getSourceMethod () {
        var sourceMethod = $('#source-method').attr('value');
        sourceMethod = sourceMethod.replace(/-source$/, '');
        return sourceMethod;
    }

    function loadSource () {
        isFromLoad = true;
        // Get schema URL
        var schemaURL = getSchemaURL();
        // Get source method
        var sourceMethod = getSourceMethod();
        lastSourceMethod = sourceMethod;

        // Set function for submitting document for validation
        switch (sourceMethod) {
        case "url":
            var documentURL = $('#url-input').val();
            uri.setSearch("url", documentURL);
            uri.setSearch("version", $('#schema-version').attr('value'));
            history.pushState({}, document.title, uri);

            //don't try validation on empty string
            sourceMethodFunc = function(schemaURL, documentURL) {
                return function () {
                    if ($.trim(documentURL).length > 0) {
                        validateViaGET(schemaURL, documentURL);
                    } else {
                        window.clearTimeout(responseTimer);
                        // true is for fail - do not disable the load button
                        loadValidateButton('stop', true);
                    }
                }
            }(schemaURL, documentURL);
            break;
        case "file":
            uri.search("");
            history.pushState({}, document.title, uri);
            
            var documentFile = $('#file-input').get(0).files[0];
            var keys = '';
            for (var key in documentFile) {
                keys += key + '\n';
            }
            sourceMethodFunc = function (schemaURL, documentFile, sourceMethod) {
                return function () {
                    validateViaPOST(schemaURL, documentFile, sourceMethod);
                }
            }(schemaURL, documentFile, sourceMethod);
            break;
        }
        validate(true);
    }

    var isFromLoad = false;

    function reValidate() {
        isFromLoad = false;
        var schemaURL = getSchemaURL();
        var sourceMethod = getSourceMethod();
        lastSourceMethod = sourceMethod;

        var documentFile = new Blob([getEditorContent()], {type: 'text/xml'});
        sourceMethodFunc = function (schemaURL, documentFile, sourceMethod) {
            return function () {
                // true is a reValidate tag, to suppress overwrite of editor data
                validateViaPOST(schemaURL, documentFile, sourceMethod, true);
            }
        }(schemaURL, documentFile, sourceMethod);
        validate();
    }

    function validate() {
        if (!sourceMethodFunc) {
            return;
        }
        $("#tabs").tabs("enable");
        loadValidateButton('start');
        $("#source-tab").click();
        responseStartTime = new Date();
        responseTimer = window.setTimeout(reportTimeOut, responseMaxTime);
        sourceMethodFunc();
        sourceMethodFunc = null;
    }

    function validateViaGET(schemaURL, documentURL) {
        $.get("http://our.law.nagoya-u.ac.jp/validate/", {
                doc: documentURL,
                schema: schemaURL,
                parser: "xml",
                laxtype: "yes",
                level: "error",
                out: "json",
                showsource: "yes"
            })
            .done(function(data) {
                parseResponse(data);
            });
    }

    function validateViaPOST(schemaURL, documentContent, sourceMethod, reValidate) {

        //if (!documentContent) {
        //    loadValidateButton('stop', true);
        //    return;
        //}

        var formData = new FormData();
        formData.append("schema", schemaURL);
        formData.append("parser", "xml");
        formData.append("laxtype", "yes");
        formData.append("level", "error");
        formData.append("out", "json");
        formData.append("showsource", "yes");

        if (sourceMethod == "textarea") {
            formData.append("content", documentContent);
        } else {
            formData.append("file", documentContent);
        }

        $.ajax({
            type: "POST",
            url: "http://our.law.nagoya-u.ac.jp/validate/",
            data: formData,
            success: function(data) {
                parseResponse(data, reValidate);
            },
            processData: false,
            contentType: false
        });
    }

    function getEditorContent() {
        var xmlStr = editor.getSession().getValue();
        while (xmlStr.slice(0,1) === '\n') {
            xmlStr = xmlStr.slice(1);
        }
        if (xmlStr.slice(0,2) !== '<?') {
            xmlStr = '<?xml version="1.0" encoding="utf-8"?>\n' + xmlStr;
        }
        return xmlStr;
    }

    function saveFile() {
        var xmlStr = getEditorContent();
        var fileName = "SomeFileName.txt"
        m = xmlStr.match(/.*<id>.*\/(.*)<\/id>/);
        if (m) {
            fileName = m[1] + ".csl";
        }
        xmlStr = btoa(xmlStr);
        var a = document.createElement('a');
        var ev = document.createEvent("MouseEvents");
        a.href = "data:application/octet-stream;charset=utf-8;base64,"+xmlStr;
        a.download = fileName;
        ev.initMouseEvent("click", true, false, self, 0, 0, 0, 0, 0,
                          false, false, false, false, 0, null);
        a.dispatchEvent(ev);
    }

    function parseResponse(data, reValidate) {
        //console.log(JSON.stringify(data));

        window.clearTimeout(responseTimer);
        responseEndTime = new Date();
        console.log("Received response from http://our.law.nagoya-u.ac.jp/validate/ after " + (responseEndTime - responseStartTime) + "ms");

        removeValidationResults(reValidate);

        var messages = data.messages;
        var errorCount = 0;
        var nonDocumentError = "";
        for (var i = 0; i < messages.length; i++) {
            if (messages[i].type == "non-document-error") {
                nonDocumentError = messages[i].message;
            } else if (messages[i].type == "error") {
                errorCount += 1;

                var results = "";
                results += '<li class="inserted">';

                var range = "";
                var firstLine = "";
                var lineText = "";
                var lastLine = messages[i].lastLine;
                var firstColumn = messages[i].firstColumn;
                var lastColumn = messages[i].lastColumn;
                if (messages[i].hasOwnProperty('firstLine')) {
                    firstLine = messages[i].firstLine;
                    range = firstLine + "-" + lastLine;
                    lineText = "Lines " + range;
                } else {
                    firstLine = lastLine;
                    lineText = "Line " + lastLine;
                }
                sourceHighlightRange = firstLine + ',' + firstColumn + ',' + lastLine + ',' + lastColumn;
                results += '<a style="text-decoration:none;padding:0.25em;border-radius:0.5em;border:1px solid black;" href="#source-code" onclick="CSLValidator.moveToLine(event,' + sourceHighlightRange + ');">' + lineText + '</a>: ';

                results += messages[i].message;
                results += "</li>";
                $("#error-list").append(results);
                $("#error-" + errorCount).text(messages[i].extract);
            }
        }

        if (nonDocumentError !== "") {
            $("#tabs").tabs("disable", "#errors");
            $('#validate').popover({
                html: true,
                title: 'Validation failed <a class="close" href="#");">&times;</a>',
                content: '<p>' + nonDocumentError + '</p>',
                trigger: 'manual',
                placement: 'bottom'
            });
            $(document).click(function (e) {
                if (($('.popover').has(e.target).length == 0) || $(e.target).is('.close')) {
                    $('#validate').popover('destroy');
                }
            });
            $('#validate').popover('show');
        } else if (errorCount === 0) {
            $("#tabs").tabs("disable", "#errors");
            $('#validate').popover({
                html: true,
                title: 'Success <a class="close" href="#");">&times;</a>',
                content: '<p>Good job! No errors found.</p><p>Interested in contributing your style or locale file? See our <a href="https://github.com/citation-style-language/styles/blob/master/CONTRIBUTING.md">instructions</a>.</p>',
                trigger: 'manual',
                placement: 'bottom'
            });
            $(document).click(function (e) {
                if (($('.popover').has(e.target).length == 0) || $(e.target).is('.close')) {
                    $('#validate').popover('destroy');
                }
            });
            $('#validate').popover('show');
        } else if (errorCount > 0) {
            if (errorCount == 1) {
                var popoverTitle = 'Oops, I found 1 error.';
            } else {
                var popoverTitle = 'Oops, I found ' + errorCount + ' errors.';
            }
            $('#validate').popover({
                html: true,
                title: popoverTitle + ' <a class="close" href="#");">&times;</a>',
                content: '<p>If you have trouble understanding the error messages below, start by reading the <a href="http://citationstyles.org/downloads/specification.html">CSL specification</a> and the <a href="http://citationstylist.org/docs/citeproc-js-csl.html">Juris-M Specification Supplement</a>.</p>',
                trigger: 'manual',
                placement: 'bottom'
            });
            $(document).click(function (e) {
                if (($('.popover').has(e.target).length == 0) || $(e.target).is('.close')) {
                    $('#validate').popover('destroy');
                }
            });
            $('#validate').popover('show');
            $("#errors").attr("class", "panel panel-warning");
            $("#errors").prepend('<div class="panel-heading inserted"><h4 id="source-title" class="panel-title">Errors <a href="#" rel="tooltip" class="glyphicon glyphicon-question-sign" data-toggle="tooltip" data-placement="auto left" title="Click the link next to an error description to highlight the relevant lines in the Source window below"></a></h4></div>');
            $('[data-toggle="tooltip"]').tooltip();
        }

        if (data.source.code.length > 0 && !reValidate) {
            $("#source").append('<div class="panel-heading inserted-to-source"><h4 id="source-title" class="panel-title">Source</h4></div>');
            $("#source").append('<div id="source-code" class="panel-body inserted-to-source"></div>');
            $("#source").attr("class", "panel panel-primary");

            var aceDoc = ace.createEditSession(data.source.code)
            pageCache[$('#source-method').attr('value')].aceDocument = aceDoc;

            setBoxHeight(['source']);
            setBoxHeight(['source-code']);

            editor = ace.edit("source-code");
            editor.setSession(aceDoc);
            editor.setReadOnly(false);
            editor.getSession().setUseWrapMode(true);
            editor.setHighlightActiveLine(true);
            editor.renderer.$cursorLayer.element.style.opacity = 1;
            editor.setTheme("ace/theme/eclipse");
            editor.getSession().setMode("ace/mode/xml");
            editor.commands.addCommand({
                name: 'saveFile',
                bindKey: {
                    win: 'Ctrl-S',
                    mac: 'Command-S',
                    sender: 'editor|cli'
                },
                exec: function(env, args, request) {
                    saveFile();
                }
            });
        } else {
            setBoxHeight(['source']);
            setBoxHeight(['source-code']);
        }

        // This gets the box - would need to resize ace also,
        // but when all alerts are moved to popupovers, resizing
        // will not be necessary. Even this can go.
        loadValidateButton('stop');
        validateButton.enable();
        saveButton.enable();
    }

    function moveToLine(event,firstLine, firstColumn, lastLine, lastColumn) {
        $("#source-tab").click();
        $("#error-banner").remove();
        var errorNode = $('<div id="error-banner" class="inserted" style="display:inline;margin-left:1em;"><span style="font-weight:bold;">ERROR @ </span><span>').get(0);
        var infoNode = event.target.parentNode.cloneNode(true);
        lineNumber = infoNode.firstChild;
        lineNumber.removeAttribute('onclick');
        lineNumber.setAttribute('style', 'color:white;font-weight:bold;text-size:smaller;');
        errorNode.appendChild(infoNode.firstChild);
        errorNode.appendChild(infoNode.lastChild);
        $("#source h4.panel-title").attr('style', 'display:inline;').after(errorNode);

        editor.scrollToLine(firstLine, true, true, function() {});
        editor.gotoLine(firstLine, 0, false);
        sourceHighlightRange = new Range(firstLine - 1, firstColumn - 1, lastLine - 1, lastColumn);
        editor.selection.setRange(sourceHighlightRange);
    }

    function removeValidationResults(reValidate) {
        $(".inserted").remove();
        //$("#errors").removeAttr("class");
        if (!reValidate) {
            //$("#source").removeAttr("class");
            $(".inserted-to-source").remove();
        }
    }

    function reportTimeOut() {
        loadValidateButton('stop');
        removeValidationResults();
        console.log("Call to http://our.law.nagoya-u.ac.jp/validate/ timed out after " + responseMaxTime + "ms.");
        $('#validate').popover({
            html: true,
            title: 'Validation timeout',
            content: '<p>This typically happens if the <a href="http://our.law.nagoya-u.ac.jp/validate/">Nagoya NU HTML Checker</a> website is down, but maybe you get lucky if you wait a little longer.</p>',
            trigger: 'manual',
            placement: 'bottom'
        });
        $(document).click(function (e) {
            if (($('.popover').has(e.target).length == 0) || $(e.target).is('.close')) {
                $('#validate').popover('destroy');
            }
        });
        $('#validate').popover('show');
    }

    return {
        init: init,
        moveToLine: moveToLine,
	    setView: setView
    };
}());
