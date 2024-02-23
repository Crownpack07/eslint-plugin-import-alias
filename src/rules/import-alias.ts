import {
    AliasConfig,
    loadAliasConfigs,
    loadTsconfig,
    resolveTsconfigFilePath,
} from "#src/alias-config";
import { AST, Rule } from "eslint";
import type {
    ExportAllDeclaration,
    ExportNamedDeclaration,
    ImportDeclaration,
    Program,
} from "estree";
import { existsSync } from "fs-extra";
import type { JSONSchema4 } from "json-schema";
import {
    dirname,
    join as joinPath,
    relative,
    resolve,
    sep as pathSep,
} from "path";
import slash from "slash";

function isPermittedRelativeImport(
    importModuleName: string,
    relativeImportOverrides: RelativeImportConfig[],
    filepath: string,
    projectBaseDir: string
) {
    const importParts = importModuleName.split("/");
    const relativeDepth = importParts.filter(
        (moduleNamePart) => moduleNamePart === ".."
    ).length;

    const configs = [...relativeImportOverrides];
    configs.sort((a, b) => b.depth - a.depth); // rank depth descending
    for (const config of configs) {
        if (
            ("path" in config && filepath.includes(resolve(config.path))) ||
            ("pattern" in config &&
                new RegExp(config.pattern).test(
                    relative(projectBaseDir, filepath)
                ))
        ) {
            return relativeDepth <= config.depth;
        }
    }
    return false;
}

function getAliasSuggestion(
    importModuleName: string,
    aliasConfigs: AliasConfig[],
    absoluteDir: string
) {
    const currentAliasConfig: AliasConfig | undefined = aliasConfigs.find(
        ({ alias }) => {
            const [baseModulePath] = importModuleName.split("/");
            return baseModulePath === alias;
        }
    );

    let absoluteModulePath: string | undefined = undefined;
    if (importModuleName.trim().charAt(0) === ".") {
        absoluteModulePath = joinPath(absoluteDir, importModuleName);
    } else if (currentAliasConfig) {
        absoluteModulePath = importModuleName
            .replace(currentAliasConfig.alias, currentAliasConfig.path.absolute)
            .replace(/\//g, pathSep);
    }

    if (absoluteModulePath) {
        const bestAliasConfig = getBestAliasConfig(
            aliasConfigs,
            currentAliasConfig,
            absoluteModulePath
        );

        if (bestAliasConfig && bestAliasConfig !== currentAliasConfig) {
            return slash(
                absoluteModulePath.replace(
                    bestAliasConfig.path.absolute,
                    bestAliasConfig.alias
                )
            );
        }
    }
}

function getBestAliasConfig(
    aliasConfigs: AliasConfig[],
    currentAlias: AliasConfig | undefined,
    absoluteModulePath: string
) {
    const importPathParts = absoluteModulePath.split(pathSep);
    return aliasConfigs.reduce((currentBest, potentialAlias) => {
        const aliasPathParts = potentialAlias.path.absolute.split(pathSep);
        const isValidAlias = aliasPathParts.reduce(
            (isValid, aliasPathPart, index) => {
                return isValid && importPathParts[index] === aliasPathPart;
            },
            true
        );
        const isMoreSpecificAlias =
            !currentBest ||
            potentialAlias.path.absolute.length >
                currentBest.path.absolute.length;
        return isValidAlias && isMoreSpecificAlias
            ? potentialAlias
            : currentBest;
    }, currentAlias);
}

interface RelativePathConfig {
    /**
     * The starting path from which a relative depth is accepted.
     *
     * @example
     * With a configuration like `{ path: "src/foo", depth: 0 }`
     *      1. Relative paths can be used in `./src/foo`.
     *      2. Relative paths can be used in `./src/foo/bar`.
     *      3. Relative paths can NOT be used in `./src`.
     *
     * @example
     * With a configuration like `{ path: "src", depth: 0 }`
     *      1. Relative paths can be used in `./src/foo`.
     *      2. Relative paths can be used in `./src/bar/baz`.
     *      3. Relative paths can be used in `./src`.
     */
    path: string;
    /**
     * A positive number which represents the relative depth
     * that is acceptable for the associated path.
     *
     * @example
     * In `./src/foo` with `path: "src"`
     *      1. `import "./bar"` for `./src/bar` when `depth` \>= `0`.
     *      2. `import "./bar/baz"` when `depth` \>= `0`.
     *      3. `import "../bar"` when `depth` \>= `1`.
     */
    depth: number;
}

interface RelativeGlobConfig {
    /**
     * A regex string pattern that is used to match the file path.
     *
     * @example
     * With a configuration like `{ pattern: "index.ts", depth: 0 }`
     *      1. Relative paths can be used in files such as `./src/index.ts`.
     *      1. Relative paths can be used any file in the folder `./src/index.ts/*`.
     *      2. Relative paths can NOT be used in files such as `./src/foo.ts`.
     *
     * @example
     * With a configuration like `{ pattern: "index\\.(ts|js)$" depth: 0 }`
     *      1. Relative paths can be used in any file that ends with `index.js` or `index.ts`.
     *      1. Relative paths can be NOT in the folder `./src/index.ts/*`.
     *      2. Relative paths can be NOT used in `./src/foo.ts`.
     */
    pattern: string;
    /**
     * A positive number which represents the relative depth
     * that is acceptable for the associated path.
     *
     * @example
     * In `./src/foo.ts` with `pattern: "foo.ts$"`
     *      1. `import "./bar"` for `./src/bar` when `depth` \>= `0`.
     *      2. `import "./bar/baz"` when `depth` \>= `0`.
     *      3. `import "../bar"` when `depth` \>= `1`.
     */
    depth: number;
}

type RelativeImportConfig = RelativePathConfig | RelativeGlobConfig;

type ImportAliasOptions = {
    aliasConfigPath?: string;
    // TODO: A fuller solution might need a property for the position, but not sure if needed
    aliasImportFunctions: string[];
    /** An array defining which paths can be allowed to used relative imports within it to defined depths. */
    relativeImportOverrides?: RelativeImportConfig[];
};

/**
 * This should match the type definition of ImportAliasOptions
 */
const schemaProperties: Record<keyof ImportAliasOptions, JSONSchema4> = {
    aliasConfigPath: {
        description: "Alternative path to look for a TSConfig/JSConfig",
        type: "string",
    },
    aliasImportFunctions: {
        type: "array",
        description:
            "Function names which supports aliases as its first function." +
            " Examples are `require` and `mock` for `jest.mock`." +
            " Please submit an issue if position parameters needs support",
        items: {
            type: "string",
        },
        default: ["require", "mock"],
    },
    relativeImportOverrides: {
        type: "array",
        default: [],
        items: {
            type: "object",
            properties: {
                path: {
                    type: "string",
                    description:
                        "The starting path from which a relative depth is accepted.",
                },
                depth: {
                    type: "number",
                    description:
                        "A positive number which represents the" +
                        " relative depth that is acceptable for the associated path.",
                },
            },
        },
    },
};

const importAliasRule: Rule.RuleModule = {
    meta: {
        docs: {
            description:
                "Suggests shortest matching alias in TSConfig/JSConfig",
            category: "Suggestions",
            recommended: true,
            url: "https://github.com/limegrass/eslint-plugin-import-alias/blob/HEAD/docs/rules/import-alias.md",
            suggestion: true,
        },
        fixable: "code",
        schema: [
            {
                type: "object",
                properties: schemaProperties,
            },
        ],
        type: "suggestion",
    },

    create: (context: Rule.RuleContext) => {
        const reportProgramError = (errorMessage: string) => {
            return {
                Program: (node: Program) => {
                    context.report({ node, message: errorMessage });
                },
            };
        };
        const cwd = context.getCwd();
        const {
            aliasConfigPath,
            aliasImportFunctions = schemaProperties.aliasImportFunctions
                .default as string[],
            relativeImportOverrides = [],
        }: ImportAliasOptions = context.options[0] || {}; // No idea what the other array values are

        let projectBaseDir: string;
        let aliasesResult: AliasConfig[];
        try {
            const configFilePath = resolveTsconfigFilePath(
                cwd,
                aliasConfigPath
            );
            const tsconfig = loadTsconfig(configFilePath);
            const configDir = dirname(configFilePath);
            projectBaseDir = joinPath(configDir, tsconfig.baseUrl);
            aliasesResult = loadAliasConfigs(tsconfig, projectBaseDir);
        } catch (error) {
            if (error instanceof Error) {
                reportProgramError(error.message);
            }
            throw error;
        }

        const filepath = resolve(context.getFilename());
        const absoluteDir = dirname(filepath);

        if (!existsSync(absoluteDir)) {
            return reportProgramError(
                "a filepath must be provided, try with --stdin-filename, " +
                    "call eslint on a file, " +
                    "or save your buffer as a file and restart eslint in your editor."
            );
        }

        const getReportDescriptor = (
            [moduleStart, moduleEnd]: [number, number],
            importModuleName: string
        ) => {
            // preserve user quote style
            const quotelessRange: AST.Range = [moduleStart + 1, moduleEnd - 1];

            if (
                isPermittedRelativeImport(
                    importModuleName,
                    relativeImportOverrides,
                    filepath,
                    projectBaseDir
                )
            ) {
                return undefined;
            }

            const aliasSuggestion = getAliasSuggestion(
                importModuleName,
                aliasesResult,
                absoluteDir
            );

            return aliasSuggestion
                ? {
                      message: `import ${importModuleName} can be written as ${aliasSuggestion}`,
                      fix: (fixer: Rule.RuleFixer) => {
                          return fixer.replaceTextRange(
                              quotelessRange,
                              aliasSuggestion
                          );
                      },
                  }
                : undefined;
        };

        const aliasModuleDeclarations = (
            node:
                | ImportDeclaration
                | ExportAllDeclaration
                | ExportNamedDeclaration
        ) => {
            if (node.source?.range && typeof node.source.value === "string") {
                const suggestion = getReportDescriptor(
                    node.source.range,
                    node.source.value
                );

                if (suggestion) {
                    context.report({ node, ...suggestion });
                }
            }
        };

        return {
            CallExpression: (node) => {
                const identifierNode =
                    node.callee.type === "MemberExpression"
                        ? node.callee.property
                        : node.callee;

                if (
                    identifierNode.type === "Identifier" &&
                    aliasImportFunctions.includes(identifierNode.name) &&
                    node.arguments.length
                ) {
                    const [importNameNode] = node.arguments;
                    if (
                        importNameNode.range &&
                        "value" in importNameNode &&
                        typeof importNameNode.value === "string"
                    ) {
                        const suggestion = getReportDescriptor(
                            importNameNode.range,
                            importNameNode.value
                        );

                        if (suggestion) {
                            context.report({ node, ...suggestion });
                        }
                    }
                }
            },
            ExportAllDeclaration: aliasModuleDeclarations,
            ExportNamedDeclaration: aliasModuleDeclarations,
            ImportDeclaration: aliasModuleDeclarations,
        };
    },
};

export { importAliasRule };
