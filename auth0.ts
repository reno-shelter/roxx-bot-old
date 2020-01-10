import {Client, ManagementClient} from "auth0";

const unifyArray = (arr: string[]) => {
    return [...new Set(arr)];
};
const removeKeyFromArray = (arr: string[], key: string) => {
    const set = new Set(arr);
    set.delete(key);
    return [...set]
};

export class Auth0Manager {
    readonly auth0: ManagementClient;
    readonly targetClientId: string;

    constructor(domain: string, clientId: string, clientSecret: string, targetClientId: string) {
        this.auth0 = new ManagementClient({
            domain,
            clientId,
            clientSecret,
            scope: 'read:clients update:clients'
        });
        this.targetClientId = targetClientId;
    }

    async add(uniqueId: string): Promise<void> {
        const baseURL = `https://${uniqueId}.preview.backcheck.jp`;
        const client = await this.auth0.getClient({client_id: this.targetClientId});

        const updateClient: Client = {
            allowed_logout_urls: unifyArray(
                [...client.allowed_logout_urls, `${baseURL}/company/signin`]),
            callbacks: unifyArray(
                [...client.callbacks, `${baseURL}/company/dashboard`]),
            web_origins: unifyArray([...client.web_origins, baseURL]),
            allowed_origins: unifyArray([...client.allowed_origins, baseURL])
        };
        await this.auth0.updateClient({client_id: this.targetClientId}, updateClient)
    }

    async remove(uniqueId: string): Promise<void> {
        const baseURL = `https://${uniqueId}.preview.backcheck.jp`;
        const client: Client = await this.auth0.getClient({client_id: this.targetClientId});

        const updateClient: Client = {
            allowed_logout_urls: removeKeyFromArray(client.allowed_logout_urls,
                `${baseURL}/company/signin`),
            callbacks: removeKeyFromArray(client.callbacks,
                `${baseURL}/company/dashboard`),
            web_origins: removeKeyFromArray(client.web_origins, baseURL),
            allowed_origins: removeKeyFromArray(client.allowed_origins, baseURL)
        };
        await this.auth0.updateClient({client_id: this.targetClientId}, updateClient)
    }

}


