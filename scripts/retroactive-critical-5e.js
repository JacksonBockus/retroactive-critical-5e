class RetroCritical5e {
	static MODULE_NAME = "retroactive-critical-5e";
	static MODULE_TITLE = "Retroactive Critical DnD5e";
	static SOCKET;

	static log(...args) {
	//	if (game.modules.get('_dev-mode')?.api?.getPackageDebugValue(this.MODULE_NAME)) {
			console.log(this.MODULE_TITLE, '|', ...args);
	//	}
	}

	static initSocket = () => {
		this.SOCKET = socketlib.registerModule(this.MODULE_NAME);
		this.SOCKET.register('handleChatButton', this._handleChatButton);
	}

	/**
	 * Handles creating a new DamageRoll instance with the updated roll method and totals based on a given one
	 * @param {DamageRoll} damageRoll - the original instance
	 * @param {boolean} isCritical - True to replace non-critical with critical, false for the reverse.
	 * @param {object} [messageOptions] - Options passed to Dice So Nice for the new roll if necessary
	 * @returns {DamageRoll} - a new DamageRoll instance with the updated details
	 */
	static async _makeNewRoll(damageRoll, isCritical, messageOptions) {
		if (isCritical === undefined) {
			throw new Error('you must provide what the new critical state is')
		}
	
		if (damageRoll.options.critical === isCritical) {
			throw new Error('provided roll is already that kind of roll');
		}
	
		// DIY Roll.clone because we want to be able to change things without mutating the original
		// Core's clone method preserves the references to the options and data objects
		let newDamageRoll = new damageRoll.constructor(damageRoll._formula, { ...damageRoll.data }, { ...damageRoll.options });
	
		newDamageRoll.options.critical = isCritical;
	
		this.log('duplicating', {
			damageRoll: damageRoll,
			newDamageRoll: newDamageRoll
		});
	
		// mutate new terms to look like old ones
		newDamageRoll.terms = [...damageRoll.terms];
		
		let rollTerms = newDamageRoll.dice;
		let originalResultsLength = 0
		let bonusDice = newDamageRoll.options.criticalBonusDice;
		for (let rollTerm of rollTerms)
		{
			originalResultsLength += rollTerm.results.length;
		
			// do stuff to the terms and modifiers
			if (!isCritical) {
				// Don't do anything to non-critical terms.
				if (!rollTerm.options.critical) {
					continue;
				}

				rollTerm.number = rollTerm.options.baseNumber;
				rollTerm.options.critical = false;
				rollTerm.results = rollTerm.results.slice(0, rollTerm.options.baseNumber); // keep only the result of the base dice.
			} else {
				let baseNumber = rollTerm.number;
				rollTerm.options.baseNumber = baseNumber;
				rollTerm.options.critical = true;
				rollTerm.number = baseNumber * 2 + bonusDice;
				bonusDice = 0;
				for (let i = baseNumber; i < rollTerm.number; i++) {
					rollTerm.roll()
				}
			}

			// clear out term flavor to prevent "Reliable Talent" loop
			rollTerm.options.flavor = undefined;
		
			// mutate each term to reset to pre-evaluateModifiers state
			rollTerm.results.forEach((term) => {
				term.active = true; // all terms start as active
				delete term.discarded; // no terms start as discarded
				delete term.indexThrow; // wtf is indexThrow
			})
		
			// handle new terms based on the roll modifiers
			rollTerm._evaluateModifiers();
		}
		// reconstruct the formula after adjusting the terms
		newDamageRoll._formula = newDamageRoll.constructor.getFormula(newDamageRoll.terms);
	
		// re-evaluate total after adjusting the terms
		newDamageRoll._total = newDamageRoll._evaluateTotal();
		return newDamageRoll;
	}

	/**
	 * Requests that the GM execute the message update to bypass permissions issue
	 * @param {*} action 
	 * @param {*} messageId 
	 */
	static async _handleRequestChatButton(action, messageId) {
		return this.SOCKET.executeAsGM(this._handleChatButton, action, messageId);
	}

	/**
	 * Handles our button clicks from the chat log
	 * @param {string} action 
	 * @param {string} messageId 
	 */
	static _handleChatButton = async (action, messageId) => {
		try {
			const chatMessage = game.messages.get(messageId);
	
			if (!messageId || !action || !chatMessage) {
				throw new Error('Missing Information')
			}
	
			let newDamageRoll;

			const messageOptions = {
				userId: chatMessage.data.user,
				whisper: chatMessage.data.whisper,
				blind: chatMessage.data.blind,
				speaker: chatMessage.data.speaker,
			};
	
			switch (action) {
				case 'crit': {
					newDamageRoll = await this._makeNewRoll(chatMessage.roll, true, messageOptions);
					break;
				}
				case 'norm': {
					newDamageRoll = await this._makeNewRoll(chatMessage.roll, false, messageOptions);
					break;
				}
			}
	
			console.log(newDamageRoll)
			const newMessageData = await newDamageRoll.toMessage({}, { create: false });
			// remove fields we definitely don't want to update
			delete newMessageData.timestamp;
			delete newMessageData.user;
			delete newMessageData.whisper;
			delete newMessageData.speaker;
	
			const messageUpdate = foundry.utils.mergeObject(
				chatMessage.toJSON(),
				newMessageData,
			);

			this.log('New stuff d20 roll', { roll: chatMessage.roll, newD20Roll: newDamageRoll }, {
				chatMessage,
				newMessageData,
				messageUpdate
			});
	
			// currently seems broken for players without socket workaround
			return chatMessage.update(messageUpdate);
		} catch (err) {
			console.error('A problem occurred with Retroactive Critical 5e:', err);
		}
	}
	
	static init() {
		console.log(`${RetroCritical5e.MODULE_NAME} | Initializing ${RetroCritical5e.MODULE_TITLE}`);

		/**
		 * Set up one listener for the whole chat log
		 */
		Hooks.on('renderChatLog', async (_chatLog, html) => {
			html.on('click', 'button[data-retrocrit-action]', async (event) => {
				event.preventDefault();
				event.stopPropagation();

				const action = event.currentTarget.dataset?.retrocritAction;

				const messageId = event.currentTarget.closest('[data-message-id]')?.dataset?.messageId;

				if (!messageId || !action) {
					return;
				}

				RetroCritical5e._handleRequestChatButton(action, messageId);
			});
		});

		/**
		 * Adorn any chat message with a damage roll with our buttons
		 */
		Hooks.on('renderChatMessage', async (chatMessage, [html]) => {
			if (!(chatMessage.isAuthor || chatMessage.isOwner) || !chatMessage.isRoll || !(chatMessage.roll instanceof CONFIG.Dice.DamageRoll || chatMessage.data.flags.dnd5e.roll.type === "damage")) {
				return;
			}
			const isCritical = chatMessage.roll?.options?.critical;

			console.log(html)
			const messageContent = html.querySelector('.message-content');
			const diceElement = messageContent.firstChild;
			console.log("Message Content", messageContent);
			console.log("Dice Element", diceElement);

			const buttonNode = document.createRange().createContextualFragment(`
			<small class="flexrow retroactive-critical-buttons">
				<button data-retrocrit-action="crit" ${isCritical ? 'disabled' : ''}>${game.i18n.localize('DND5E.Critical')}</button>
				<button data-retrocrit-action="norm" ${!isCritical ? 'disabled' : ''}>${game.i18n.localize('DND5E.Normal')}</button>
			</small>
			`);

			messageContent.insertBefore(buttonNode, diceElement);
		});
	}
}

Hooks.on("init", RetroCritical5e.init);

Hooks.once('devModeReady', ({ registerPackageDebugFlag }) => {
	registerPackageDebugFlag(RetroCritical5e.MODULE_NAME);
});

Hooks.once("socketlib.ready", RetroCritical5e.initSocket);
