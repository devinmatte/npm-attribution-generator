#!/usr/bin/env node

// usage
var yargs = require('yargs')(process.argv.slice(2))
    .usage('Calculate the npm modules used in this project and generate a third-party attribution (credits) text.')
    .option('outputDir', {
        alias: 'o',
        type: 'string',
        default: './oss-attribution',
        description: 'Output directory for attribution files'
    })
    .option('baseDir', {
        alias: 'b',
        type: 'array',
        default: [process.cwd()],
        description: 'Base directory(ies) to scan for dependencies'
    })
    .example('$0 -o ./tpn', 'run the tool and output text and backing json to ${projectRoot}/tpn directory.')
    .example('$0 -b ./some/path/to/projectDir', 'run the tool for NPM projects in another directory.')
    .example('$0 -o tpn -b ./some/path/to/projectDir', 'run the tool in some other directory and dump the output in a directory called "tpn" there.')
    .help('h')
    .alias('h', 'help');

var argv = yargs.argv;

// dependencies
var bluebird = require('bluebird');
var _ = require('lodash');
var npmchecker = require('license-checker');
var path = require('path');
var jetpack = require('fs-jetpack');
var cp = require('child_process');
var os = require('os');
var taim = require('taim');

// const
var licenseCheckerCustomFormat = {
    name: '',
    version: '',
    description: '',
    repository: '',
    publisher: '',
    email: '',
    url: '',
    licenses: '',
    licenseFile: '',
    licenseModified: false
}

/**
 * Helpers
 */
function getAttributionForAuthor(a) {
    return _.isString(a) ? a : a.name + ((a.email || a.homepage || a.url) ? ` <${a.email || a.homepage || a.url}>` : '');
}

function getNpmLicenses() {
    var npmDirs;
    if (!Array.isArray(options.baseDir)) {
        npmDirs = [options.baseDir];
    } else {
        npmDirs = options.baseDir;
    }
    // first - check that this is even an NPM project
    for (var i = 0; i < npmDirs.length; i++) {
        if (!jetpack.exists(path.join(npmDirs[i], 'package.json'))) {
            console.log('directory at "' + npmDirs[i] + '" does not look like an NPM project, skipping NPM checks for path ' + npmDirs[i]);
            return [];
        }
        
        // Check if node_modules exists
        if (!jetpack.exists(path.join(npmDirs[i], 'node_modules'))) {
            console.log('WARNING: No node_modules directory found in "' + npmDirs[i] + '".');
            console.log('Please run "npm install" or "yarn install" in that directory first.');
            console.log('Skipping NPM checks for path ' + npmDirs[i]);
            return [];
        }
    }
    console.log('Looking at directories: ' + npmDirs)

    var res = []
    var checkers = [];
    for (var i = 0; i < npmDirs.length; i++) {
        checkers.push(
            bluebird.fromCallback((cb) => {
                var dir = npmDirs[i];
                return npmchecker.init({
                    start: npmDirs[i],
                    production: true,
                    customFormat: licenseCheckerCustomFormat
                }, function (err, json) {
                    if (err) {
                        //Handle error
                        console.error('Error scanning directory "' + dir + '":', err.message);
                        console.error('This might be due to corrupted package.json or node_modules. Try running "npm install" again.');
                        return cb(err, {});
                    } else {
                        Object.getOwnPropertyNames(json).forEach(k => {
                            json[k]['dir'] = dir;
                        })
                    }
                    cb(err, json);
                });
            })
        );
    }
    if (checkers.length === 0) {
        return bluebird.resolve({});
    }

    return bluebird.all(checkers)
        .then((raw_result) => {
            // the result is passed in as an array, one element per npmDir passed in
            // de-dupe the entries and merge it into a single object
            var merged = {};
            for (var i = 0; i < raw_result.length; i++) {
                merged = Object.assign(raw_result[i], merged);
            }
            return merged;
        }).then((result) => {
            
            // we want to exclude the top-level project from being included
            var dir = result[Object.keys(result)[0]]['dir'];
            var topLevelProjectInfo = jetpack.read(path.join(dir, 'package.json'), 'json');
            var keys = Object.getOwnPropertyNames(result).filter((k) => {
                return k !== `${topLevelProjectInfo.name}@${topLevelProjectInfo.version}`;
            });

            return bluebird.map(keys, (key) => {
                console.log('processing', key);

                var package = result[key];
                var defaultPackagePath = `${package['dir']}/node_modules/${package.name}/package.json`;
      
                var itemAtPath = jetpack.exists(defaultPackagePath);
                var packagePath = [defaultPackagePath];
      
                if (itemAtPath !== 'file') {
                  packagePath = jetpack.find(package['dir'], {
                    matching: `**/node_modules/${package.name}/package.json`
                  });
                }
      
                var packageJson = "";
      
                if (packagePath && packagePath[0]) {
                  packageJson = jetpack.read(packagePath[0], 'json');
                } else {

                  return Promise.reject(`${package.name}: unable to locate package.json`);
                }
      
                console.log('processing', packageJson.name, 'for authors and licenseText');
      
                var props = {};
      
                props.authors =
                  (packageJson.author && getAttributionForAuthor(packageJson.author)) ||
                  (packageJson.contributors && packageJson.contributors
                      .map(c => {

                        return getAttributionForAuthor(c);
                      }).join(', ')) ||
                  (packageJson.maintainers && packageJson.maintainers
                      .map(m => {

                        return getAttributionForAuthor(m);
                      }).join(', '));
      
                var licenseFile = package.licenseFile;
      
                try {
                  if (licenseFile && jetpack.exists(licenseFile) && path.basename(licenseFile).match(/license/i)) {
                    props.licenseText = jetpack.read(licenseFile);
                  } else {
                    props.licenseText = '';
                  }
                } catch (e) {
                  console.warn(e);

                  return {            
                    authors: '',
                    licenseText: ''
                  };
                }
      
                return {
                  ignore: false,
                  name: package.name,
                  version: package.version,
                  authors: props.authors,
                  url: package.repository,
                  license: package.licenses,
                  licenseText: props.licenseText
                };
            }, {
                concurrency: os.cpus().length
            });
        });
}


/***********************
 *
 * MAIN
 *
 ***********************/

// sanitize inputs
var options = {
    baseDir: [],
    outputDir: path.resolve(argv.outputDir)
};

for (var i = 0; i < argv.baseDir.length; i++) {
    options.baseDir.push(path.resolve(argv.baseDir[i]));
}


taim('Total Processing', getNpmLicenses())
    .catch((err) => {
        console.log(err);
        process.exit(1);
    })
    .then((npmOutput) => {
        var o = {};
        npmOutput = npmOutput || [];
        npmOutput.forEach((v) => {
            o[v.name] = v;
        });

        var userOverridesPath = path.join(options.outputDir, 'overrides.json');
        if (jetpack.exists(userOverridesPath)) {
            var userOverrides = jetpack.read(userOverridesPath, 'json');
            console.log('using overrides:', userOverrides);
            // foreach override, loop through the properties and assign them to the base object.
            o = _.defaultsDeep(userOverrides, o);
        }

        return o;
    })
    .catch(e => {
        console.error('ERROR processing overrides', e);
        process.exit(1);
    })
    .then((licenseInfos) => {
        var attributionSequence = _(licenseInfos).filter(licenseInfo => {
            return !licenseInfo.ignore && licenseInfo.name != undefined;
        }).sortBy(licenseInfo => {
            return licenseInfo.name.toLowerCase();
        }).map(licenseInfo => {
            return [licenseInfo.name,`${licenseInfo.version} <${licenseInfo.url}>`,
                    licenseInfo.licenseText || `license: ${licenseInfo.license}${os.EOL}authors: ${licenseInfo.authors}`].join(os.EOL);
        }).value();

        var attribution = attributionSequence.join(`${os.EOL}${os.EOL}******************************${os.EOL}${os.EOL}`);

        var headerPath = path.join(options.outputDir, 'header.txt');
        
        if (jetpack.exists(headerPath)) {
            var template = jetpack.read(headerPath);
            console.log('using template', template);
            attribution = template + os.EOL + os.EOL + attribution;
        }

        jetpack.write(path.join(options.outputDir, 'licenseInfos.json'), JSON.stringify(licenseInfos));

        var packageCount = Object.keys(licenseInfos).length;
        console.log('Generated attribution for ' + packageCount + ' packages');

        return jetpack.write(path.join(options.outputDir, 'attribution.txt'), attribution);
    })
    .catch(e => {
        console.error('ERROR writing attribution file', e);
        process.exit(1);
    })
    .then(() => {
        console.log('done');
        process.exit();
    });
