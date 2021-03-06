/// <reference path="../../csv-streamify.d.ts" />
/// <reference path="../xlsx.d.ts" />

// tsc --project tsconfig.build-hash.json && node ./build-hash.js

declare global {
  // Augment Node.js `global`
  namespace NodeJS {
    interface Global {
      XMLHttpRequest: XMLHttpRequest;
    }
  }
  // Augment Browser `window`
  //interface Window extends NodeJS.Global { }
  // Augment Web Worker `self`
  //interface WorkerGlobalScope extends NodeJS.Global { }
}

if (!global.hasOwnProperty("XMLHttpRequest")) {
  global.XMLHttpRequest = require("xhr2");
}

import * as fs from "fs";
import { keys, toPairs, union } from "lodash";
const csv = require("csv-streamify");
import * as XLSX from "xlsx";
import { Observable } from "rxjs/Observable";
import { AjaxRequest } from "rxjs/observable/dom/AjaxObservable";
import "rxjs/add/observable/dom/ajax";
import "rxjs/add/observable/bindNodeCallback";
import "rxjs/add/observable/concat";
import "rxjs/add/observable/merge";
import "rxjs/add/observable/from";
import "rxjs/add/observable/pairs";
import "rxjs/add/operator/do";
import "rxjs/add/operator/let";
import "rxjs/add/operator/map";
import "rxjs/add/operator/mergeAll";
import "rxjs/add/operator/mergeMap";
import "rxjs/add/operator/reduce";
import "rxjs/add/operator/shareReplay";
import "rxjs/add/operator/toArray";
import "rx-extra/add/operator/throughNodeStream";
const fileExists = require("file-exists");
const JSONStream = require("JSONStream");
const path = require("path");

/*****************
 * Inputs
 ***************/
const ORGANISMS = ["Homo sapiens", "Mus musculus"];
const KINASE_TARGETS = path.resolve(__dirname, "../PF_I2T_Kinases.tsv");
const MIRTARBASE_MTI_URL =
  "http://mirtarbase.mbc.nctu.edu.tw/cache/download/7.0/miRTarBase_MTI.xlsx";
const GMT_HUMAN_URL =
  "http://data.wikipathways.org/current/gmt/wikipathways-20180210-gmt-Homo_sapiens.gmt";
const GMT_MOUSE_URL =
  "http://data.wikipathways.org/current/gmt/wikipathways-20180210-gmt-Mus_musculus.gmt";

/*****************
 * Outputs
 ***************/
const MIRTARBASE_MTI_FILEPATH = path.resolve(
  __dirname,
  "../miRTarBase_MTI_7.0.xlsx"
);
const GMT_FILEPATH = path.resolve(__dirname, "../gmt.json");
const MIRNA_TO_TARGETS_FILEPATH = path.resolve(
  __dirname,
  "../miRNA-to-targets.json"
);
const GENE_TO_PATHWAYS_FILEPATH = path.resolve(
  __dirname,
  "../gene-to-pathways.json"
);
const PATHWAY_DETAILS_FILEPATH = path.resolve(
  __dirname,
  "../pathway-details.json"
);
const INPUTS_TO_TARGETS_FILEPATH = path.resolve(
  __dirname,
  "../inputs-to-targets.json"
);

const CSV_OPTIONS = {
  objectMode: true,
  delimiter: "\t",
  columns: true,
  newline: "\r\n"
};

// TODO improve this to be more specify than "any"
// TODO move this into rx-extra
declare module "rxjs/Observable" {
  interface Observable<T> {
    toNodeStream: any;
  }
}
Observable.prototype.toNodeStream = function(stream) {
  const obs = this;
  obs.subscribe(
    function(x) {
      stream.write(x);
    },
    function(err) {
      console.error("err");
      console.error(err);
      //stream.error(err);
    },
    function() {
      stream.end();
    }
  );
};

let miRNAToTargetsSource;
if (!fileExists.sync(MIRNA_TO_TARGETS_FILEPATH)) {
  let miRTarBase_MTISource;
  if (fileExists.sync(MIRTARBASE_MTI_FILEPATH)) {
    miRTarBase_MTISource = Observable.bindNodeCallback(function(fp, cb) {
      fs.readFile(fp, cb);
    })(MIRTARBASE_MTI_FILEPATH);
  } else {
    const ajaxRequest: AjaxRequest = {
      url: MIRTARBASE_MTI_URL,
      method: "GET",
      responseType: "arraybuffer",
      timeout: 1 * 1000, // ms
      crossDomain: true
    };
    miRTarBase_MTISource = Observable.ajax(ajaxRequest)
      .map((ajaxResponse): Buffer => Buffer.from(ajaxResponse.xhr.response))
      .toArray()
      .map(function(buffers) {
        return Buffer.concat(buffers);
      })
      .shareReplay();

    // cache spreadsheet so we don't have to download it again
    miRTarBase_MTISource.toNodeStream(
      fs.createWriteStream(MIRTARBASE_MTI_FILEPATH)
    );
  }

  miRNAToTargetsSource = miRTarBase_MTISource
    .toArray()
    .map(function(buffers) {
      return Buffer.concat(buffers);
    })
    .map(function(buffer) {
      /* Call XLSX */
      return XLSX.read(buffer, {
        type: "buffer",
        cellFormula: false,
        cellHTML: false,
        cellStyles: false
      });
    })
    .mergeMap(function(workbook) {
      const sheetName = workbook.SheetNames[0];
      const workSheet = workbook.Sheets[sheetName];

      return Observable.from(
        XLSX.utils
          .sheet_to_json(workSheet)
          // only include "Functional MTI", not
          // "Functional MTI (Weak)", "Non-Functional MTI" or "Non-Functional MTI (Weak)"
          .filter(row => row["Support Type"] === "Functional MTI")
          .map(row => ({
            organism: row["Species (miRNA)"],
            miRNA: row.miRNA,
            target: row["Target Gene (Entrez ID)"]
          }))
          .filter(x => ORGANISMS.indexOf(x.organism) > -1)
      );
    })
    .shareReplay();

  const stringifyMiRNATargets = JSONStream.stringify();
  miRNAToTargetsSource
    .throughNodeStream(stringifyMiRNATargets)
    .toNodeStream(fs.createWriteStream(MIRNA_TO_TARGETS_FILEPATH));
} else {
  miRNAToTargetsSource = Observable.bindNodeCallback(function(fp, options, cb) {
    fs.readFile(fp, options, cb);
  })(MIRNA_TO_TARGETS_FILEPATH, "utf8").throughNodeStream(
    JSONStream.parse("*")
  );
}

const kinaseToTargetSource = Observable.bindNodeCallback(function(
  fp,
  options,
  cb
) {
  fs.readFile(fp, options, cb);
})(KINASE_TARGETS, "utf8")
  .throughNodeStream(csv(CSV_OPTIONS))
  .map(function({ input, target }) {
    return {
      miRNA: input,
      target
    };
  });

const stringifyInputsToTargets = JSONStream.stringifyObject();
Observable.merge(kinaseToTargetSource, miRNAToTargetsSource)
  .reduce(function(acc: any, { miRNA, target }) {
    const targets = (acc[miRNA] = acc[miRNA] || []);
    if (targets.indexOf(target) === -1) {
      targets.push(target);
    }
    return acc;
  }, {})
  .mergeMap(function(x) {
    return Observable.from(toPairs(x));
  })
  .throughNodeStream(stringifyInputsToTargets)
  .toNodeStream(fs.createWriteStream(INPUTS_TO_TARGETS_FILEPATH));

let gmtSource;
if (fileExists.sync(GMT_FILEPATH)) {
  gmtSource = Observable.bindNodeCallback(function(fp, options, cb) {
    fs.readFile(fp, options, cb);
  })(GMT_FILEPATH, "utf8").throughNodeStream(JSONStream.parse("*"));
} else {
  const ajaxRequestHuman: AjaxRequest = {
    url: GMT_HUMAN_URL,
    method: "GET",
    responseType: "text",
    timeout: 1 * 1000, // ms
    crossDomain: true
  };
  const ajaxRequestMouse: AjaxRequest = {
    url: GMT_MOUSE_URL,
    method: "GET",
    responseType: "text",
    timeout: 1 * 1000, // ms
    crossDomain: true
  };
  gmtSource = Observable.concat(
    Observable.ajax(ajaxRequestHuman).map(
      (ajaxResponse): string => ajaxResponse.xhr.responseText
    ),
    Observable.ajax(ajaxRequestMouse).map(
      (ajaxResponse): string => ajaxResponse.xhr.responseText
    )
  )
    .reduce(
      function(acc: { lines: string[]; rem: string }, text: string) {
        let { lines, rem } = acc;
        const splitByNewline = (rem + text).split("\n");
        splitByNewline
          .splice(0, splitByNewline.length - 1)
          .forEach(function(line) {
            lines.push(line);
          });
        acc.rem = splitByNewline[0];
        return acc;
      },
      { lines: [], rem: "" }
    )
    .mergeMap(x => Observable.from(x.lines))
    .map(function(line) {
      const [title, date, identifier, rest] = line.split("%");
      const [organism, id, ...genes] = rest.split("\t");
      return { title, date, identifier, organism, id, genes };
    });

  const stringifyGMT = JSONStream.stringify();
  gmtSource
    .throughNodeStream(stringifyGMT)
    .toNodeStream(fs.createWriteStream(GMT_FILEPATH));
  /*
			.subscribe(function(gmt, i) {
				if (i === 0) {
					fs.writeFileSync(GMT_FILEPATH, gmt);
				} else {
					fs.appendFileSync(GMT_FILEPATH, gmt);
				}
			})
			//*/
}

const stringifyPathwayDetails = JSONStream.stringifyObject();
gmtSource
  .reduce(function(
    acc,
    {
      title,
      date,
      identifier,
      organism,
      id,
      genes
    }: {
      title: string;
      date: string;
      identifier: string;
      organism: string;
      id: string;
      genes: string[];
    }
  ) {
    acc[identifier] = title;
    return acc;
  }, {})
  .mergeMap(function(x) {
    return Observable.from(toPairs(x));
  })
  .throughNodeStream(stringifyPathwayDetails)
  .toNodeStream(fs.createWriteStream(PATHWAY_DETAILS_FILEPATH));

const stringifyGeneToPathways = JSONStream.stringifyObject();
gmtSource
  .map(function({ title, date, identifier, organism, id, genes }) {
    return { pathway: identifier, genes };
  })
  .reduce(function(acc, x: { pathway: string; genes: string[] }) {
    const pathway = x.pathway;
    x.genes.forEach(function(gene) {
      let genes = (acc[gene] = acc[gene] || []);
      genes.push(pathway);
    });
    return acc;
  }, {})
  .mergeMap(function(x) {
    return Observable.from(toPairs(x));
  })
  .throughNodeStream(stringifyGeneToPathways)
  .toNodeStream(fs.createWriteStream(GENE_TO_PATHWAYS_FILEPATH));
