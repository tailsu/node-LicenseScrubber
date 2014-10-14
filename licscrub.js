var path = require('path');
var url = require('url');
var util = require('util');
var fs = require('fs');
var semver = require('semver');
var request = require('request');
var Q = require('q');
var _ = require('lodash');
var async = require('async');
require('colors');

var start = process.argv[2];
var maxLevel = +process.argv[3] || 1;

function httpGet(url) {
	var promise = Q.defer();
	request(url, function(error, response, body) {
		if (error) {
			promise.reject(error);
		}
		if (response.statusCode != 200) {
			promise.reject(Error(response.statusCode));
		}
		promise.resolve(body);
	});
	return promise.promise;
}

function downloadModuleData(moduleName) {
	var registryUrl = util.format('http://registry.npmjs.org/%s', moduleName);
	//console.log('TRA: Downloading module data from %s', registryUrl);
	return httpGet(registryUrl)
		.then(function(body) {
			return JSON.parse(body);
		});
}

function getPackageDataForVersion(moduleData, versionMatcher) {
	var versions = Object.keys(moduleData.versions);
	versions.sort(function(a, b) { return semver.gt(a, b) ? -1 : 1; });
	var bestMatch = _.find(versions, function(v) {
		return semver.satisfies(v, versionMatcher);
	});

	var versionData = moduleData.versions[bestMatch];
	return versionData;
}

function extractRepoPath(packageData) {
	var repository = packageData.repository;
	if (repository && repository.url) {
		repository = repository.url;
	}
	return repository;
}

function getRawAccessPath(packageData) {
	var repoUrl = extractRepoPath(packageData);
	if (!repoUrl) {
		return null;
	}
	repoUrl = repoUrl.replace(/^git\+/, '');
	var parsed = url.parse(repoUrl);
	if (parsed.host !== 'github.com') {
		return null;
	}
	var repoPath = parsed.pathname.replace('.git', '');
	return util.format("https://raw.github.com%s/master/", repoPath);
}

function traverseDependencyHash(dependencyHash, level, callback) {
	if (!dependencyHash) {
		return;
	}
	Object.keys(dependencyHash).forEach(function(dep) {
		traverseDependencies(dep, dependencyHash[dep], level, callback);
	});
}

function getPackageDataFromTarballUrl(tarballUrl) {
	var parsed = url.parse(tarballUrl);
	if (parsed.host != 'github.com') {
		return Q.reject();
	}
	var components = parsed.pathname.split('/');
	if (!components[0]) {
		components.shift();
	}
	var repoPath = util.format("%s/%s", components[0], components[1]);
	var packageJsonUrl = util.format("https://raw.github.com/%s/master/package.json", repoPath);
	//console.log("Trying to download %s".cyan, packageJsonUrl);
	return httpGet(packageJsonUrl)
		.then(function(body) {
			return JSON.parse(body);
		});
}

function traverseDependencies(module, version, level, callback) {
	if (_.isString(module)) {
		var localPath = path.join(module, "package.json");
		if (fs.existsSync(localPath)) {
			//console.log("TRA: %s exists.", localPath);
			fs.readFile(localPath, function(error, contents) {
				var packageData = JSON.parse(contents.toString());
				if (callback(error, module, packageData, null, level)) {
					if (!error) {
						traverseDependencies(packageData, null, level, callback);
					}
				}
			})
		} else {
			if (semver.validRange(version)) {
				downloadModuleData(module)
					.then(function (moduleData) {
						var packageData = getPackageDataForVersion(moduleData, version);
						if (callback(null, module, packageData, moduleData, level)) {
							traverseDependencies(packageData, null, level, callback);
						}
					})
					.fail(function(error) {
						callback(error);
					});
			} else {
				getPackageDataFromTarballUrl(version)
					.then(function(packageData) {
						if (callback(null, module, packageData, null, level)) {
							traverseDependencies(packageData, null, level, callback);
						}
					})
					.fail(function(error) {
						console.log("Invalid semver: %s (%s)".yellow, version, error);
					});
			}
		}
	} else {
		traverseDependencyHash(module.dependencies, level + 1, callback);
		traverseDependencyHash(module.devDependencies, level + 1, callback);
		traverseDependencyHash(module.optionalDependencies, level + 1, callback);
	}
}

function getLicenseUrl(packageData) {
	var future = Q.defer();
	var rawAccessPath = getRawAccessPath(packageData);
	if (rawAccessPath) {
		//console.log("Trying to find license file in %s", rawAccessPath);
		var possibleNames = ["LICENSE", "COPYING", "LICENSE.md", "COPYING.md"]
			.map(function(name) { return rawAccessPath + name; });

		async.detectSeries(possibleNames, function(item, callback) {
			httpGet(item)
				.then(function() { callback(true); })
				.fail(function() { callback(false); });
		}, function(result) {
			if (result) {
				future.resolve(result);
			} else {
				console.log("%s has no license info.".yellow, moduleName);
				future.reject();
			}
		})

	} else {
		console.log("%s has no license info.".yellow, moduleName);
		future.reject();
	}
	return future.promise;
}

function printLicense(moduleName, packageData, moduleData) {
	if (!packageData) {
		packageData = _.find(moduleData.versions, function(v) {
			return v.license || v.licenses;
		})
		if (!packageData) {
			packageData = {};
		}
	}

	var licenseInfo = packageData.license || packageData.licenses || (moduleData ? moduleData.license || moduleData.licenses : null);

	if (licenseInfo) {
		if (_.isArray(licenseInfo)) {
			licenseInfo = licenseInfo[0];
		}
		var licenseName = _.isString(licenseInfo) ? licenseInfo : (licenseInfo.type || licenseInfo.url);
		var licenseUrl = licenseInfo.url;
	}

	if (!licenseUrl) {
		getLicenseUrl(packageData)
			.then(function(licenseUrl) {
				prettyPrintLicense(moduleName, licenseName, licenseUrl);
			});
	} else {
		prettyPrintLicense(moduleName, licenseName, licenseUrl);
	}
}

function prettyPrintLicense(module, license, licenseUrl) {
	console.log("Appbuilder,%s,%s,,,No,%s", module, license, licenseUrl);
}

traverseDependencies(start, null, 0, function(error, moduleName, packageData, moduleData, level) {
	if (error) {
		util.error(error);
	}
	printLicense(moduleName, packageData, moduleData);
	return level < maxLevel;
});
