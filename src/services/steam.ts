import { HelperService } from "./helper";

const SteamCommunity = require("steamcommunity");
const TradeOfferManager = require("steam-tradeoffer-manager");
const SteamTotp = require("steam-totp");
const Request = require('request');

export class SteamService {
	private readonly maxRetry = 5;
	private retries = {};
	private managers = {};
	private steams = {};
	private helperService: HelperService;

	constructor() {
		this.helperService = new HelperService();
		this.init();
	}

	async init() {
		for await (const config of this.helperService.config.settings.csgoempire) {

			if (config.steam.accountName) {
				await this.initLogin(config);
				await this.helperService.delay(10000);
			}
		}
	}
	async initLogin(config) {
		try {
			let initObject = {};
			if (config.steam.proxy) {
				initObject = {
					'request': Request.defaults({ 'proxy': config.steam.proxy }),
				}
			}
			this.steams[config.steam.accountName] = new SteamCommunity(initObject);

			const cookies = await this.login(config.steam);

			this.helperService.sendMessage(
				`Steam login success for ${config.steam.accountName}`,
				"steamLoginSuccess"
			);

			this.managers[
				config.steam.accountName
			] = new TradeOfferManager({
				domain: "localhost",
				language: "en",
				pollInterval: 120000,
				// cancelTime: 9 * 60 * 1000, // cancel outgoing offers after 9mins
				community: this.steams[config.steam.accountName],
			});

			this.managers[config.steam.accountName].setCookies(
				cookies,
				function (err) {
					if (err) {
						console.log(err);
						return;
					}
				}
			);

			this.steams[config.steam.accountName].on('sessionExpired', async () => {
				this.helperService.sendMessage(
					`Steam session expired for ${config.steam.accountName}`,
					"steamSessionExpired"
				);

				// Sign back in
				const cookies = await this.login(config.steam);

				this.managers[config.steam.accountName].setCookies(
					cookies,
					function (err) {
						if (err) {
							console.log(err);
							return;
						}
					}
				);

				this.helperService.sendMessage(
					`Steam login success for ${config.steam.accountName}`,
					"steamLoginSuccess"
				);
			});

			if (config.steam.acceptOffers) {
				// Accepts all offers empty from our side
				this.managers[config.steam.accountName].on(
					"newOffer",
					(offer) => {
						if (
							offer.itemsToGive.length > 0 &&
							!offer.isOurOffer
						) {
							// offer.decline();
						} else {
							offer.accept();
						}
					}
				);
			}
		} catch (err) {
			this.helperService.sendMessage(
				`Steam login failed for ${config.steam.accountName}: ${err.message}`,
				"steamLoginFailed"
			);

			await this.helperService.delay(60000); // 60s because of steam guard
			return await this.initLogin(config);
		}
	}
	async steamGuardConfirmation(steam: Steam, offer: any) {
		return new Promise(async (resolve, reject) => {
			try {
				this.steams[steam.accountName].acceptConfirmationForObject(
					steam.identitySecret,
					offer.id,
					(err: Error | null) => {
						if (err) {
							if (offer.isGlitched()) {
								this.helperService.log(`[#${offer.id}] Offer is glitched. (Empty from both side)`, 2);
							}
							this.helperService.log(`[#${offer.id}] Failed to Confirm the offer, retry in 5 seconds.`, 2);
							setTimeout(async () => {
								resolve(await this.steamGuardConfirmation(
									offer,
									steam.identitySecret
								));
							}, 30000); // Increased this in case of Steam is down, do not spam the endpoint and get ratelimited.
						}
						resolve(offer);
					}
				);
			} catch (e) {
				await this.helperService.delay(20000);
				await this.login(steam);
				return this.steamGuardConfirmation(steam, offer);
			}
		})
	}
	async send(offer) {
		return new Promise((resolve, reject) => {
			offer.send(async (err, status) => {
				if (err) {
					if (!this.retries[offer.items[0].assetid]) {
						this.retries[offer.items[0].assetid] = 1;
					}
					this.retries[offer.items[0].assetid]++;

					if (this.retries[offer.items[0].assetid] > this.maxRetry) {
						this.helperService.log('The sending process was unsuccessful after 5 retries, Probably item id changed.', 2);
						reject();
					}
					this.helperService.log('The sending process was unsuccessful. Try again in 10 seconds.', 2);
					await this.helperService.delay(1e4);
					resolve(await this.send(offer));
				} else {
					resolve(offer.id);
				}
			});
		});
	}
	async sendOffer(sendItem, tradeURL: string, userId: number) {
		const config = this.helperService.config.settings.csgoempire.find(
			(config) => config.userId === userId
		);
		const items = [];
		items.push({
			assetid: sendItem.asset_id,
			appid: 730,
			contextid: "2",
		});
		const offer = this.managers[config.steam.accountName].createOffer(
			tradeURL
		);
		offer.addMyItems(items);
		try {
			const offerId = await this.send(offer);
			this.helperService.log(`[#${offerId}] Offer created for ${sendItem.market_name}`, 1);
		} catch (e) {
			this.helperService.log(`Failed to create the Steam offer. ${sendItem.market_name}#${sendItem.asset_id}`, 2);
		}

		await this.helperService.delay(1e4);

		try {
			await this.steamGuardConfirmation(
				config.steam,
				offer,
			);
			this.helperService.log(`[#${offer.id}] Offer Confirmed for ${sendItem.market_name}`, 1);
		} catch (e) { }

	}
	async login(steam: Steam) {
		return new Promise((resolve, reject) => {
			this.steams[steam.accountName].login(
				{
					accountName: steam.accountName,
					password: steam.password,
					twoFactorCode: SteamTotp.getAuthCode(steam.sharedSecret),
				},
				function (err, sessionID, cookies, steamguard) {
					if (err) {
						return reject(err);
					}
					return resolve(cookies);
				}
			);
		});
	}
}
