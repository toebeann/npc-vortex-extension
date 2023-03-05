import "@total-typescript/ts-reset";
import { join } from "path";
import Nexus from "@nexusmods/nexus-api";
import { Callback, Result, callbackSchema, create } from "@toebean/npc";
import { CreateNexusApi, CreateVortexApi, RegisterNpcApi, nexus, npcApiSchema } from "@toebean/npc-vortex-api";
import deepmerge from "deepmerge";
import { log, types, util } from "vortex-api";
import { z } from "zod";

/**
 * Entry-point for the Vortex extension. Handles registering all Vortex extension API functions for use by other extensions,
 * and registering NPC endpoints for our built-in methods.
 * @param {types.IExtensionApi} context The Vortex extension context.
 */
export default function main(context: types.IExtensionContext) {
    context.registerAPI('createNexusApi', () => createNexusApi(context.api), { minArguments: 0 });
    context.registerAPI('createVortexApi', () => createVortexApi(context.api), { minArguments: 0 });
    context.registerAPI('registerNpcApi', registerNpcApi, { minArguments: 2 });

    context.once(async () => {
        // here we are using the extension API calls we have registered with Vortex rather than simply calling the functions directly
        // for the purposes of dog-fooding; we want to ensure that the experience for consumers of this extension is the same as our own
        const registerNpcApi: RegisterNpcApi = context.api.ext.registerNpcApi;
        await Promise.all([
            registerNpcApi('nexus', context.api.ext.createNexusApi()),
            registerNpcApi('.', context.api.ext.createVortexApi()),
        ]);
    });
}

registerNpcApi satisfies RegisterNpcApi; // this line ensures registerNpcApi satisfies the RegisterNpcApi interface
function registerNpcApi(path: string, callback: Callback): Promise<string>;
function registerNpcApi<T>(path: string, callback: (input: T) => Result, middleware: (input: unknown) => T): Promise<string>;
function registerNpcApi(namespace: string, api: z.infer<typeof npcApiSchema>): Promise<string[]>;
async function registerNpcApi<T>(pathOrNamespace: string, callbackOrApi: Callback | ((input: T) => Result) | Record<string, unknown>, middleware?: (input: unknown) => T) {
    pathOrNamespace = z.string().parse(pathOrNamespace);

    if (callbackSchema.safeParse(callbackOrApi).success) {
        const path = pathOrNamespace;
        const callback = callbackSchema.parse(callbackOrApi);
        const npc = middleware
            ? create(callback, callbackSchema.parse(middleware))
            : create(callback);
        npc.on('error', (error) => log('warn', error.message, error));
        await npc.listen(join('vortex', path));
        return npc.endpoint;
    } else {
        const namespace = pathOrNamespace;
        const api = npcApiSchema.parse(callbackOrApi);
        const promises: Promise<string | undefined>[] = [];

        for (const property in api) {
            if (!callbackSchema.safeParse(api[property]).success) { continue; }
            promises.push(
                api.middleware?.[property] && callbackSchema.safeParse(api.middleware[property]).success
                    ? registerNpcApi(join(namespace, property), <Callback>api[property], <Callback>api.middleware[property])
                    : registerNpcApi(join(namespace, property), <Callback>api[property]));
        }

        return Promise.all(promises);
    }
}

const createVortexApi: CreateVortexApi = (api: types.IExtensionApi) => {
    const getState = api.getState;

    const getActiveProfile = (state: types.IState): types.IProfile | void => state.persistent.profiles[state.settings.profiles.activeProfileId];
    const getMods = (state: types.IState, profile = getActiveProfile(state)) => profile
        ? deepmerge({ ...profile.modState }, { ...state.persistent.mods[profile.gameId] })
        : {};

    return {
        ensureLoggedIn: () => api.ext.ensureLoggedIn?.(),
        getActiveProfile: () => getActiveProfile(getState()),
        getCurrentGame: () => util.currentGame(api.store),
        getMods: () => getMods(getState())
    }
};

const createNexusApi: CreateNexusApi = (api: types.IExtensionApi) => {
    let nexusApi: Nexus | undefined;

    const getNexus = () => {
        const getAccount = () => z.object({ nexus: z.object({ APIKey: z.string().optional() }).optional() })
            .parse(api.getState().confidential.account);

        let account = getAccount();
        return nexusApi && account.nexus?.APIKey && account.nexus?.APIKey === nexusApi.getValidationResult()?.key
            ? Promise.resolve(nexusApi)
            : (async () => {
                const app = util.getApplication();
                await api.ext.ensureLoggedIn?.() ?? Promise.resolve();
                return (account = getAccount()).nexus?.APIKey
                    ? nexusApi = await Nexus.create(account.nexus.APIKey, app.name, app.version, (await util.currentGame(api.store)).id)
                    : Promise.reject();
            })();
    }

    return {
        endorseMod: async (input) => nexus.schemas.iEndorseResponseSchema
            .parse(await (await getNexus()).endorseMod(input.modId, input.modVersion, input.endorseStatus, input.gameId)),

        getChangelogs: async (input) => nexus.schemas.iChangelogsSchema.parse(await (await getNexus()).getChangelogs(input.modId, input.gameId)),

        getCollection: async (input) => nexus.schemas.iCollectionSchema.parse(await api.ext.nexusGetCollection?.(input.slug)),

        getCollectionRevision: async (input) => nexus.schemas.iRevisionSchema
            .parse(await api.ext.nexusGetCollectionRevision?.(input.collectionSlug, input.revisionNumber)),

        getCollections: async (input) => nexus.schemas.iCollectionSchema.array().parse(await api.ext.nexusGetCollections?.(input.gameId)),

        getColorSchemes: async () => nexus.schemas.iColourSchemeSchema.array().parse(await (await getNexus()).getColorschemes()),

        getDownloadUrls: async (input) => nexus.schemas.iDownloadURLSchema.array()
            .parse(await (await getNexus()).getDownloadURLs(input.modId, input.fileId, input.key, input.expires, input.gameId)),

        getEndorsements: async () => nexus.schemas.iEndorsementSchema.array().parse(await (await getNexus()).getEndorsements()),

        getFileByMd5: async (input) => nexus.schemas.iMD5ResultSchema.array().parse(await (await getNexus()).getFileByMD5(input.hash, input.gameId)),

        getFileInfo: async (input) => nexus.schemas.iFileInfoSchema.parse(await (await getNexus()).getFileInfo(input.modId, input.fileId, input.gameId)),

        getGameInfo: async (input) => nexus.schemas.iGameInfoSchema.parse(await (await getNexus()).getGameInfo(input.gameId)),

        getGames: async () => nexus.schemas.iGameListEntrySchema.array().parse(await (await getNexus()).getGames()),

        getLatestAdded: async (input) => nexus.schemas.iModInfoSchema.array().parse(await (await getNexus()).getLatestAdded(input.gameId)),

        getLatestUpdated: async (input) => nexus.schemas.iModInfoSchema.array().parse(await (await getNexus()).getLatestUpdated(input.gameId)),

        getModFiles: async (input) => nexus.schemas.iModFilesSchema.parse(await (await getNexus()).getModFiles(input.modId, input.gameId)),

        getModInfo: async (input) => nexus.schemas.iModInfoSchema.parse(await (await getNexus()).getModInfo(input.modId, input.gameId)),

        getMyCollections: async (input) => nexus.schemas.iRevisionSchema.array().parse(await api.ext.nexusGetMyCollections?.(input.gameId, input.count, input.offset)),

        getRateLimits: async () => z.object({ daily: z.number(), hourly: z.number() }).parse((await getNexus()).getRateLimits()),

        getRecentlyUpdatedMods: async (input) => nexus.schemas.iUpdateEntrySchema.array()
            .parse(await (await getNexus()).getRecentlyUpdatedMods(input.period, input.gameId)),

        getTrackedMods: async () => nexus.schemas.iTrackedModSchema.array().parse(await (await getNexus()).getTrackedMods()),

        getTrending: async (input) => nexus.schemas.iModInfoSchema.array().parse(await (await getNexus()).getTrending(input.gameId)),

        getValidationResult: async () => nexus.schemas.iValidateKeyResponseSchema.parse((await getNexus()).getValidationResult()),

        rateCollectionRevision: async (input) => z.unknown().parse(await api.ext.nexusRateCollectionRevision?.(input.revisionId, input.rating)),

        resolveCollectionUrl: async (input) => nexus.schemas.iDownloadURLSchema.array().parse(await api.ext.nexusResolveCollectionUrl?.(input.apiLink)),

        trackMod: async (input) => nexus.schemas.iTrackedModSchema.parse(await (await getNexus()).trackMod(input.modId, input.gameId)),

        untrackMod: async (input) => nexus.schemas.iTrackedModSchema.parse(await (await getNexus()).untrackMod(input.modId, input.gameId)),

        middleware: {
            endorseMod: nexus.schemas.endorseModArgsSchema.parse,
            getChangelogs: nexus.schemas.modIdArgsSchema.parse,
            getCollection: nexus.schemas.getCollectionArgsSchema.parse,
            getCollectionRevision: nexus.schemas.getCollectionRevisionArgsSchema.parse,
            getCollections: nexus.schemas.gameIdArgsSchema.parse,
            getDownloadUrls: nexus.schemas.getDownloadUrlArgsSchema.parse,
            getFileByMd5: nexus.schemas.getFileByMd5ArgsSchema.parse,
            getFileInfo: nexus.schemas.fileIdArgsSchema.parse,
            getGameInfo: nexus.schemas.gameIdArgsSchema.parse,
            getLatestAdded: nexus.schemas.gameIdArgsSchema.parse,
            getLatestUpdated: nexus.schemas.gameIdArgsSchema.parse,
            getModFiles: nexus.schemas.modIdArgsSchema.parse,
            getModInfo: nexus.schemas.modIdArgsSchema.parse,
            getMyCollections: nexus.schemas.getMyCollectionsArgsSchema.parse,
            getRecentlyUpdatedMods: nexus.schemas.getRecentlyUpdatedModsArgsSchema.parse,
            getTrending: nexus.schemas.gameIdArgsSchema.parse,
            rateCollectionRevision: nexus.schemas.rateCollectionRevisionArgsSchema.parse,
            resolveCollectionUrl: nexus.schemas.resolveCollectionUrlArgsSchema.parse,
            trackMod: nexus.schemas.trackModArgsSchema.parse,
            untrackMod: nexus.schemas.trackModArgsSchema.parse,
        }
    }
};
