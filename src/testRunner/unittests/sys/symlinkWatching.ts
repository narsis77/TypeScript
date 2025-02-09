import * as fs from "fs";

import {
    IO,
} from "../../_namespaces/Harness";
import * as ts from "../../_namespaces/ts";
import {
    defer,
    Deferred,
} from "../../_namespaces/Utils";
import {
    createWatchedSystem,
    FileOrFolderOrSymLinkMap,
    TestServerHostOsFlavor,
} from "../helpers/virtualFileSystemWithWatch";
describe("unittests:: sys:: symlinkWatching::", () => {
    function delayedOp(op: () => void, delay: number) {
        ts.sys.setTimeout!(op, delay);
    }

    function modifiedTimeToString(d: Date | undefined) {
        if (!d) return undefined;
        return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
    }

    function verifyWatchFile(
        scenario: string,
        sys: ts.System,
        file: string,
        link: string,
        watchOptions: Pick<ts.WatchOptions, "watchFile">,
        getFileName?: (file: string) => string,
    ) {
        it(scenario, async () => {
            const fileResult = watchFile(file);
            const linkResult = watchFile(link);

            await writeFile(file);
            await writeFile(link);

            fileResult.watcher.close();
            linkResult.watcher.close();

            function watchFile(toWatch: string) {
                const result = {
                    watcher: sys.watchFile!(
                        toWatch,
                        (fileName, eventKind, modifiedTime) => {
                            assert.equal(fileName, toWatch);
                            assert.equal(eventKind, ts.FileWatcherEventKind.Changed);
                            const actual = modifiedTimeToString(modifiedTime);
                            assert(actual === undefined || actual === modifiedTimeToString(sys.getModifiedTime!(file)));
                            result.deferred.resolve();
                        },
                        10,
                        watchOptions,
                    ),
                    deferred: undefined! as Deferred<void>,
                };
                return result;
            }

            async function writeFile(onFile: string) {
                fileResult.deferred = defer();
                linkResult.deferred = defer();
                delayedOp(() => sys.writeFile(getFileName?.(onFile) ?? onFile, "export const x = 100;"), 100);
                // Should invoke on file as well as link
                await fileResult.deferred.promise;
                await linkResult.deferred.promise;
            }
        });
    }

    interface EventAndFileName {
        event: string;
        fileName: string | null | undefined;
    }
    interface ExpectedEventAndFileName {
        event: string | readonly string[]; // Its expected event name or any of the event names
        fileName: string | null | undefined;
    }
    type FsWatch<System extends ts.System> = (dir: string, recursive: boolean, cb: ts.FsWatchCallback, sys: System) => ts.FileWatcher;
    interface WatchDirectoryResult {
        dir: string;
        watcher: ts.FileWatcher;
        actual: EventAndFileName[];
    }
    function watchDirectory<System extends ts.System>(
        sys: System,
        fsWatch: FsWatch<System>,
        dir: string,
        recursive: boolean,
    ) {
        const result: WatchDirectoryResult = {
            dir,
            watcher: fsWatch(
                dir,
                recursive,
                (event, fileName) => result.actual.push({ event, fileName: fileName ? ts.normalizeSlashes(fileName) : fileName }),
                sys,
            ),
            actual: [],
        };
        return result;
    }

    function initializeWatchDirectoryResult(...results: WatchDirectoryResult[]) {
        results.forEach(result => result.actual.length = 0);
    }

    function verfiyWatchDirectoryResult(
        opType: string,
        dirResult: WatchDirectoryResult,
        linkResult: WatchDirectoryResult,
        expectedResult: readonly ExpectedEventAndFileName[] | undefined,
    ) {
        const deferred = defer();
        delayedOp(() => {
            if (opType !== "init") {
                verifyEventAndFileNames(`${opType}:: dir`, dirResult.actual, expectedResult);
                verifyEventAndFileNames(`${opType}:: link`, linkResult.actual, expectedResult);
            }
            deferred.resolve();
        }, 4000);
        return deferred.promise;
    }

    function verifyEventAndFileNames(
        prefix: string,
        actual: readonly EventAndFileName[],
        expected: readonly ExpectedEventAndFileName[] | undefined,
    ) {
        assert(actual.length >= (expected?.length ?? 0), `${prefix}:: Expected ${JSON.stringify(expected)} events, got ${JSON.stringify(actual)}`);
        let expectedIndex = 0;
        for (const a of actual) {
            if (isExpectedEventAndFileName(a, expected![expectedIndex])) {
                expectedIndex++;
                continue;
            }
            // Previous event repeated?
            if (isExpectedEventAndFileName(a, expected![expectedIndex - 1])) continue;
            ts.Debug.fail(`${prefix}:: Expected ${JSON.stringify(expected)} events, got ${JSON.stringify(actual)}`);
        }
        assert(expectedIndex >= (expected?.length ?? 0), `${prefix}:: Should get all events: Expected ${JSON.stringify(expected)} events, got ${JSON.stringify(actual)}`);
    }

    function isExpectedEventAndFileName(actual: EventAndFileName, expected: ExpectedEventAndFileName | undefined) {
        return !!expected &&
            actual.fileName === expected.fileName &&
            (ts.isString(expected.event) ? actual.event === expected.event : ts.contains(expected.event, actual.event));
    }

    interface FsEventsForWatchDirectory extends Record<string, readonly ExpectedEventAndFileName[] | undefined> {
        // The first time events are most of the time are not predictable, so just create random file for that reason
        init?: readonly ExpectedEventAndFileName[];
        fileCreate: readonly ExpectedEventAndFileName[];
        linkFileCreate: readonly ExpectedEventAndFileName[];
        fileChange: readonly ExpectedEventAndFileName[];
        fileModifiedTimeChange: readonly ExpectedEventAndFileName[];
        linkModifiedTimeChange: readonly ExpectedEventAndFileName[];
        linkFileChange: readonly ExpectedEventAndFileName[];
        fileDelete: readonly ExpectedEventAndFileName[];
        linkFileDelete: readonly ExpectedEventAndFileName[];
    }
    function verifyWatchDirectoryUsingFsEvents<System extends ts.System>(
        sys: System,
        fsWatch: FsWatch<System>,
        dir: string,
        link: string,
        osFlavor: TestServerHostOsFlavor,
    ) {
        it(`watchDirectory using fsEvents`, async () => {
            const tableOfEvents: FsEventsForWatchDirectory = osFlavor === TestServerHostOsFlavor.MacOs ?
                {
                    fileCreate: [
                        { event: "rename", fileName: "file1.ts" },
                    ],
                    linkFileCreate: [
                        { event: "rename", fileName: "file2.ts" },
                    ],
                    fileChange: [
                        // On MacOs 18 and below we might get rename or change and its not deterministic
                        { event: ["rename", "change"], fileName: "file1.ts" },
                    ],
                    linkFileChange: [
                        // On MacOs 18 and below we might get rename or change and its not deterministic
                        { event: ["rename", "change"], fileName: "file2.ts" },
                    ],
                    fileModifiedTimeChange: [
                        // On MacOs 18 and below we might get rename or change and its not deterministic
                        { event: ["rename", "change"], fileName: "file1.ts" },
                    ],
                    linkModifiedTimeChange: [
                        // On MacOs 18 and below we might get rename or change and its not deterministic
                        { event: ["rename", "change"], fileName: "file2.ts" },
                    ],
                    fileDelete: [
                        { event: "rename", fileName: "file1.ts" },
                    ],
                    linkFileDelete: [
                        { event: "rename", fileName: "file2.ts" },
                    ],
                } :
                osFlavor === TestServerHostOsFlavor.Windows ?
                {
                    fileCreate: [
                        { event: "rename", fileName: "file1.ts" },
                        { event: "change", fileName: "file1.ts" },
                    ],
                    linkFileCreate: [
                        { event: "rename", fileName: "file2.ts" },
                        { event: "change", fileName: "file2.ts" },
                    ],
                    fileChange: [
                        { event: "change", fileName: "file1.ts" },
                    ],
                    linkFileChange: [
                        { event: "change", fileName: "file2.ts" },
                    ],
                    fileModifiedTimeChange: [
                        { event: "change", fileName: "file1.ts" },
                    ],
                    linkModifiedTimeChange: [
                        { event: "change", fileName: "file2.ts" },
                    ],
                    fileDelete: [
                        { event: "rename", fileName: "file1.ts" },
                    ],
                    linkFileDelete: [
                        { event: "rename", fileName: "file2.ts" },
                    ],
                } :
                {
                    fileCreate: [
                        { event: "rename", fileName: "file1.ts" },
                        { event: "change", fileName: "file1.ts" },
                    ],
                    linkFileCreate: [
                        { event: "rename", fileName: "file2.ts" },
                        { event: "change", fileName: "file2.ts" },
                    ],
                    fileChange: [
                        { event: "change", fileName: "file1.ts" },
                    ],
                    linkFileChange: [
                        { event: "change", fileName: "file2.ts" },
                    ],
                    fileModifiedTimeChange: [
                        { event: "change", fileName: "file1.ts" },
                    ],
                    linkModifiedTimeChange: [
                        { event: "change", fileName: "file2.ts" },
                    ],
                    fileDelete: [
                        { event: "rename", fileName: "file1.ts" },
                    ],
                    linkFileDelete: [
                        { event: "rename", fileName: "file2.ts" },
                    ],
                };
            await testWatchDirectoryOperations(
                sys,
                fsWatch,
                tableOfEvents,
                operation,
                dir,
                link,
                /*recursive*/ false,
                [
                    "init",
                    "fileCreate",
                    "linkFileCreate",
                    "fileChange",
                    "linkFileChange",
                    "fileModifiedTimeChange",
                    "linkModifiedTimeChange",
                    "fileDelete",
                    "linkFileDelete",
                ],
            );

            function operation(opType: keyof FsEventsForWatchDirectory) {
                switch (opType) {
                    case "init":
                        sys.writeFile(`${dir}/init.ts`, "export const x = 100;");
                        break;
                    case "fileCreate":
                    case "linkFileCreate":
                        sys.writeFile(fileName(opType), "export const x = 100;");
                        break;
                    case "fileChange":
                    case "linkFileChange":
                        sys.writeFile(fileName(opType), "export const x2 = 100;");
                        break;
                    case "fileModifiedTimeChange":
                    case "linkModifiedTimeChange":
                        sys.setModifiedTime!(fileName(opType), new Date());
                        break;
                    case "fileDelete":
                    case "linkFileDelete":
                        sys.deleteFile!(fileName(opType));
                        break;
                }
            }

            function fileName(opType: string) {
                return ts.startsWith(opType, "file") ?
                    `${dir}/file1.ts` :
                    `${link}/file2.ts`;
            }
        });
    }

    interface RecursiveFsEventsForWatchDirectory extends FsEventsForWatchDirectory {
        linkSubFileCreate: readonly ExpectedEventAndFileName[];
        linkSubFileChange: readonly ExpectedEventAndFileName[];
        linkSubModifiedTimeChange: readonly ExpectedEventAndFileName[];
        linkSubFileDelete: readonly ExpectedEventAndFileName[] | undefined;

        parallelFileCreate: readonly ExpectedEventAndFileName[] | undefined;
        parallelLinkFileCreate: readonly ExpectedEventAndFileName[] | undefined;
        parallelFileChange: readonly ExpectedEventAndFileName[] | undefined;
        parallelLinkFileChange: readonly ExpectedEventAndFileName[] | undefined;
        parallelFileModifiedTimeChange: readonly ExpectedEventAndFileName[] | undefined;
        parallelLinkModifiedTimeChange: readonly ExpectedEventAndFileName[] | undefined;
        parallelFileDelete: readonly ExpectedEventAndFileName[] | undefined;
        parallelLinkFileDelete: readonly ExpectedEventAndFileName[] | undefined;
    }
    function verifyRecursiveWatchDirectoryUsingFsEvents<System extends ts.System>(
        sys: System,
        fsWatch: FsWatch<System>,
        dir: string,
        link: string,
        osFlavor: TestServerHostOsFlavor.Windows | TestServerHostOsFlavor.MacOs,
    ) {
        const tableOfEvents: RecursiveFsEventsForWatchDirectory = osFlavor === TestServerHostOsFlavor.MacOs ?
            {
                fileCreate: [
                    { event: "rename", fileName: "sub/folder/file1.ts" },
                ],
                linkFileCreate: [
                    { event: "rename", fileName: "sub/folder/file2.ts" },
                ],
                fileChange: [
                    // On MacOs 18 and below we might get rename or change and its not deterministic
                    { event: ["rename", "change"], fileName: "sub/folder/file1.ts" },
                ],
                linkFileChange: [
                    // On MacOs 18 and below we might get rename or change and its not deterministic
                    { event: ["rename", "change"], fileName: "sub/folder/file2.ts" },
                ],
                fileModifiedTimeChange: [
                    // On MacOs 18 and below we might get rename or change and its not deterministic
                    { event: ["rename", "change"], fileName: "sub/folder/file1.ts" },
                ],
                linkModifiedTimeChange: [
                    // On MacOs 18 and below we might get rename or change and its not deterministic
                    { event: ["rename", "change"], fileName: "sub/folder/file2.ts" },
                ],
                fileDelete: [
                    { event: "rename", fileName: "sub/folder/file1.ts" },
                ],
                linkFileDelete: [
                    { event: "rename", fileName: "sub/folder/file2.ts" },
                ],

                linkSubFileCreate: [
                    { event: "rename", fileName: "sub/folder/file3.ts" },
                ],
                linkSubFileChange: [
                    // On MacOs 18 and below we might get rename or change and its not deterministic
                    { event: ["rename", "change"], fileName: "sub/folder/file3.ts" },
                ],
                linkSubModifiedTimeChange: [
                    // On MacOs 18 and below we might get rename or change and its not deterministic
                    { event: ["rename", "change"], fileName: "sub/folder/file3.ts" },
                ],
                linkSubFileDelete: [
                    { event: "rename", fileName: "sub/folder/file3.ts" },
                ],

                parallelFileCreate: undefined,
                parallelLinkFileCreate: undefined,
                parallelFileChange: undefined,
                parallelLinkFileChange: undefined,
                parallelFileModifiedTimeChange: undefined,
                parallelLinkModifiedTimeChange: undefined,
                parallelFileDelete: undefined,
                parallelLinkFileDelete: undefined,
            } :
            {
                fileCreate: [
                    { event: "rename", fileName: "sub/folder/file1.ts" },
                    { event: "change", fileName: "sub/folder/file1.ts" },
                    { event: "change", fileName: "sub/folder" },
                ],
                linkFileCreate: [
                    { event: "rename", fileName: "sub/folder/file2.ts" },
                    { event: "change", fileName: "sub/folder/file2.ts" },
                    { event: "change", fileName: "sub/folder" },
                ],
                fileChange: [
                    { event: "change", fileName: "sub/folder/file1.ts" },
                ],
                linkFileChange: [
                    { event: "change", fileName: "sub/folder/file2.ts" },
                ],
                fileModifiedTimeChange: [
                    { event: "change", fileName: "sub/folder/file1.ts" },
                ],
                linkModifiedTimeChange: [
                    { event: "change", fileName: "sub/folder/file2.ts" },
                ],
                fileDelete: [
                    { event: "rename", fileName: "sub/folder/file1.ts" },
                ],
                linkFileDelete: [
                    { event: "rename", fileName: "sub/folder/file2.ts" },
                ],

                linkSubFileCreate: [
                    { event: "rename", fileName: "sub/folder/file3.ts" },
                    { event: "change", fileName: "sub/folder/file3.ts" },
                    { event: "change", fileName: "sub/folder" },
                ],
                linkSubFileChange: [
                    { event: "change", fileName: "sub/folder/file3.ts" },
                ],
                linkSubModifiedTimeChange: [
                    { event: "change", fileName: "sub/folder/file3.ts" },
                ],
                linkSubFileDelete: [
                    { event: "rename", fileName: "sub/folder/file3.ts" },
                ],

                parallelFileCreate: undefined,
                parallelLinkFileCreate: undefined,
                parallelFileChange: undefined,
                parallelLinkFileChange: undefined,
                parallelFileModifiedTimeChange: undefined,
                parallelLinkModifiedTimeChange: undefined,
                parallelFileDelete: undefined,
                parallelLinkFileDelete: undefined,
            };

        it(`recursive watchDirectory using fsEvents`, async () => {
            await testWatchDirectoryOperations(
                sys,
                fsWatch,
                tableOfEvents,
                watchDirectoryOperation,
                dir,
                link,
                /*recursive*/ true,
                [
                    "init",
                    "fileCreate",
                    "linkFileCreate",
                    "fileChange",
                    "linkFileChange",
                    "fileModifiedTimeChange",
                    "linkModifiedTimeChange",
                    "fileDelete",
                    "linkFileDelete",
                ],
            );
        });

        it(`recursive watchDirectory using fsEvents when linked in same folder`, async () => {
            await testWatchDirectoryOperations(
                sys,
                fsWatch,
                tableOfEvents,
                watchDirectoryOperation,
                `${dir}sub`,
                `${link}sub`,
                /*recursive*/ true,
                [
                    "init",
                    "linkSubFileCreate",
                    "linkSubFileChange",
                    "linkSubModifiedTimeChange",
                    "linkSubFileDelete",
                ],
            );
        });

        it(`recursive watchDirectory using fsEvents when links not in directory`, async () => {
            await testWatchDirectoryOperations(
                sys,
                fsWatch,
                tableOfEvents,
                watchDirectoryOperation,
                `${dir}parallel`,
                `${link}parallel`,
                /*recursive*/ true,
                [
                    "init",
                    "parallelFileCreate",
                    "parallelLinkFileCreate",
                    "parallelFileChange",
                    "parallelLinkFileChange",
                    "parallelFileModifiedTimeChange",
                    "parallelLinkModifiedTimeChange",
                    "parallelFileDelete",
                    "parallelLinkFileDelete",
                ],
            );
        });

        function watchDirectoryOperation(
            opType: keyof RecursiveFsEventsForWatchDirectory,
            dir: string,
            link: string,
        ) {
            switch (opType) {
                case "init":
                    sys.writeFile(`${dir}/sub/folder/init.ts`, "export const x = 100;");
                    sys.writeFile(`${dir}2/sub/folder/init.ts`, "export const x = 100;");
                    break;
                case "fileCreate":
                case "linkFileCreate":
                case "linkSubFileCreate":
                case "parallelFileCreate":
                case "parallelLinkFileCreate":
                    sys.writeFile(fileName(dir, link, opType), "export const x = 100;");
                    break;
                case "fileChange":
                case "linkFileChange":
                case "linkSubFileChange":
                case "parallelFileChange":
                case "parallelLinkFileChange":
                    sys.writeFile(fileName(dir, link, opType), "export const x2 = 100;");
                    break;
                case "fileModifiedTimeChange":
                case "linkModifiedTimeChange":
                case "linkSubModifiedTimeChange":
                case "parallelFileModifiedTimeChange":
                case "parallelLinkModifiedTimeChange":
                    sys.setModifiedTime!(fileName(dir, link, opType), new Date());
                    break;
                case "fileDelete":
                case "linkFileDelete":
                case "linkSubFileDelete":
                case "parallelFileDelete":
                case "parallelLinkFileDelete":
                    sys.deleteFile!(fileName(dir, link, opType));
                    break;
            }
        }

        function fileName(dir: string, link: string, opType: string) {
            return ts.startsWith(opType, "file") ?
                `${dir}/sub/folder/file1.ts` :
                ts.startsWith(opType, "linkSub") ?
                `${dir}/linkedsub/folder/file3.ts` :
                ts.startsWith(opType, "link") ?
                `${link}/sub/folder/file2.ts` :
                ts.startsWith(opType, "parallelFile") ?
                `${dir}2/sub/folder/file4.ts` :
                `${dir}/linkedsub2/sub/folder/file5.ts`;
        }
    }

    type EventRecord = Record<string, readonly ExpectedEventAndFileName[] | undefined>;
    type Operation<Events extends EventRecord> = (opType: keyof Events, dir: string, link: string) => void;
    async function testWatchDirectoryOperations<System extends ts.System, Events extends EventRecord>(
        sys: System,
        fsWatch: FsWatch<System>,
        tableOfEvents: Events,
        operation: Operation<Events>,
        directoryName: string,
        linkName: string,
        recursive: boolean,
        opTypes: (keyof Events & string)[],
    ) {
        const dirResult = watchDirectory(sys, fsWatch, directoryName, recursive);
        const linkResult = watchDirectory(sys, fsWatch, linkName, recursive);

        for (const opType of opTypes) {
            await watchDirectoryOperation(tableOfEvents, opType, operation, directoryName, linkName, dirResult, linkResult);
        }

        dirResult.watcher.close();
        linkResult.watcher.close();
    }

    async function watchDirectoryOperation<Events extends EventRecord>(
        tableOfEvents: Events,
        opType: keyof Events & string,
        operation: Operation<Events>,
        directoryName: string,
        linkName: string,
        dirResult: WatchDirectoryResult,
        linkResult: WatchDirectoryResult,
    ) {
        initializeWatchDirectoryResult(dirResult, linkResult);
        operation(opType, directoryName, linkName);
        await verfiyWatchDirectoryResult(
            opType,
            dirResult,
            linkResult,
            tableOfEvents[opType],
        );
    }

    function getFileName(): (dir: string) => string {
        return dir => `${dir}/${ts.getBaseFileName(dir)}.ts`;
    }

    describe("with ts.sys::", () => {
        const root = ts.normalizePath(IO.joinPath(IO.getWorkspaceRoot(), "tests/baselines/symlinks"));
        const osFlavor = process.platform === "darwin" ?
            TestServerHostOsFlavor.MacOs :
            process.platform === "win32" ?
            TestServerHostOsFlavor.Windows :
            TestServerHostOsFlavor.Linux;
        before(() => {
            cleanup();
        });
        after(() => {
            cleanup();
        });
        function cleanup() {
            withSwallowException(() => fs.rmSync(root, { recursive: true, force: true }));
        }
        function withSwallowException(op: () => void) {
            try {
                op();
            }
            catch { /* swallow */ }
        }
        describe("watchFile using polling", () => {
            before(() => {
                ts.sys.writeFile(`${root}/polling/file.ts`, "export const x = 10;");
                withSwallowException(() => fs.symlinkSync(`${root}/polling`, `${root}/linkedpolling`, "junction"));
            });
            verifyWatchFile(
                "watchFile using polling",
                ts.sys,
                `${root}/polling/file.ts`,
                `${root}/linkedpolling/file.ts`,
                { watchFile: ts.WatchFileKind.PriorityPollingInterval },
            );
        });
        describe("watchFile using fsEvents", () => {
            before(() => {
                ts.sys.writeFile(`${root}/fsevents/file.ts`, "export const x = 10;");
                withSwallowException(() => fs.symlinkSync(`${root}/fsevents`, `${root}/linkedfsevents`, "junction"));
            });
            verifyWatchFile(
                "watchFile using fsEvents",
                ts.sys,
                `${root}/fsevents/file.ts`,
                `${root}/linkedfsevents/file.ts`,
                { watchFile: ts.WatchFileKind.UseFsEvents },
            );
        });
        describe("watchDirectory using polling", () => {
            before(() => {
                ts.sys.writeFile(`${root}/dirpolling/file.ts`, "export const x = 10;");
                withSwallowException(() => fs.symlinkSync(`${root}/dirpolling`, `${root}/linkeddirpolling`, "junction"));
            });
            verifyWatchFile(
                "watchDirectory using polling",
                ts.sys,
                `${root}/dirpolling`,
                `${root}/linkeddirpolling`,
                { watchFile: ts.WatchFileKind.PriorityPollingInterval },
                getFileName(),
            );
        });
        describe("watchDirectory using fsEvents", () => {
            before(() => {
                ts.sys.writeFile(`${root}/dirfsevents/file.ts`, "export const x = 10;");
                withSwallowException(() => fs.symlinkSync(`${root}/dirfsevents`, `${root}/linkeddirfsevents`, "junction"));
            });
            verifyWatchDirectoryUsingFsEvents(
                ts.sys,
                (dir, _recursive, cb) => fs.watch(dir, { persistent: true }, cb),
                `${root}/dirfsevents`,
                `${root}/linkeddirfsevents`,
                osFlavor,
            );
        });

        if (osFlavor !== TestServerHostOsFlavor.Linux) {
            describe("recursive watchDirectory using fsEvents", () => {
                before(() => {
                    setupRecursiveFsEvents("recursivefsevents");
                    setupRecursiveFsEvents("recursivefseventssub");
                    setupRecursiveFsEvents("recursivefseventsparallel");
                });
                verifyRecursiveWatchDirectoryUsingFsEvents(
                    ts.sys,
                    (dir, recursive, cb) => fs.watch(dir, { persistent: true, recursive }, cb),
                    `${root}/recursivefsevents`,
                    `${root}/linkedrecursivefsevents`,
                    osFlavor,
                );
            });
        }

        function setupRecursiveFsEvents(recursiveName: string) {
            ts.sys.writeFile(`${root}/${recursiveName}/sub/folder/file.ts`, "export const x = 10;");
            ts.sys.writeFile(`${root}/${recursiveName}2/sub/folder/file.ts`, "export const x = 10;");
            withSwallowException(() => fs.symlinkSync(`${root}/${recursiveName}`, `${root}/linked${recursiveName}`, "junction"));
            withSwallowException(() => fs.symlinkSync(`${root}/${recursiveName}/sub`, `${root}/${recursiveName}/linkedsub`, "junction"));
            withSwallowException(() => fs.symlinkSync(`${root}/${recursiveName}2`, `${root}/${recursiveName}/linkedsub2`, "junction"));
        }
    });

    describe("with virtualFileSystem::", () => {
        const root = ts.normalizePath("/tests/baselines/symlinks");
        function getSys(osFlavor?: TestServerHostOsFlavor) {
            return createWatchedSystem({
                [`${root}/folder/file.ts`]: "export const x = 10;",
                [`${root}/linked`]: { symLink: `${root}/folder` },
            }, { osFlavor });
        }
        verifyWatchFile(
            "watchFile using polling",
            getSys(),
            `${root}/folder/file.ts`,
            `${root}/linked/file.ts`,
            { watchFile: ts.WatchFileKind.PriorityPollingInterval },
        );
        verifyWatchFile(
            "watchFile using fsEvents",
            getSys(),
            `${root}/folder/file.ts`,
            `${root}/linked/file.ts`,
            { watchFile: ts.WatchFileKind.UseFsEvents },
        );

        verifyWatchFile(
            "watchDirectory using polling",
            getSys(),
            `${root}/folder`,
            `${root}/linked`,
            { watchFile: ts.WatchFileKind.PriorityPollingInterval },
            getFileName(),
        );

        function verifyWatchDirectoryUsingFsEventsTestServerHost(osFlavor: TestServerHostOsFlavor) {
            verifyWatchDirectoryUsingFsEvents(
                getSys(osFlavor),
                (dir, recursive, cb, sys) => sys.fsWatchWorker(dir, recursive, cb),
                `${root}/folder`,
                `${root}/linked`,
                osFlavor,
            );
        }
        verifyWatchDirectoryUsingFsEventsTestServerHost(TestServerHostOsFlavor.Windows);
        verifyWatchDirectoryUsingFsEventsTestServerHost(TestServerHostOsFlavor.MacOs);
        verifyWatchDirectoryUsingFsEventsTestServerHost(TestServerHostOsFlavor.Linux);

        function getRecursiveSys(osFlavor: TestServerHostOsFlavor) {
            return createWatchedSystem({
                ...getRecursiveFs("recursivefsevents"),
                ...getRecursiveFs("recursivefseventssub"),
                ...getRecursiveFs("recursivefseventsparallel"),
            }, { osFlavor });

            function getRecursiveFs(recursiveName: string): FileOrFolderOrSymLinkMap {
                return {
                    [`${root}/${recursiveName}/sub/folder/file.ts`]: "export const x = 10;",
                    [`${root}/${recursiveName}2/sub/folder/file.ts`]: "export const x = 10;",
                    [`${root}/linked${recursiveName}`]: { symLink: `${root}/${recursiveName}` },
                    [`${root}/${recursiveName}/linkedsub`]: { symLink: `${root}/${recursiveName}/sub` },
                    [`${root}/${recursiveName}/linkedsub2`]: { symLink: `${root}/${recursiveName}2` },
                };
            }
        }

        function verifyRecursiveWatchDirectoryUsingFsEventsTestServerHost(osFlavor: TestServerHostOsFlavor.Windows | TestServerHostOsFlavor.MacOs) {
            verifyRecursiveWatchDirectoryUsingFsEvents(
                getRecursiveSys(osFlavor),
                (dir, recursive, cb, sys) => sys.fsWatchWorker(dir, recursive, cb),
                `${root}/recursivefsevents`,
                `${root}/linkedrecursivefsevents`,
                osFlavor,
            );
        }
        verifyRecursiveWatchDirectoryUsingFsEventsTestServerHost(TestServerHostOsFlavor.Windows);
        verifyRecursiveWatchDirectoryUsingFsEventsTestServerHost(TestServerHostOsFlavor.MacOs);
    });
});
