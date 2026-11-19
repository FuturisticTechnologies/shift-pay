var ShiftPayMoney = Class.create();

/**
 * ShiftPayMoney
 * =============
 * Totalling money that may not all be in one currency (BR-X6).
 *
 * THE RULE: amounts in different currencies are never added together, and
 * never converted — ShiftPay holds no exchange rates. A total is therefore a
 * list of { currency, amount }, one entry per currency. One entry is the
 * ordinary case; more than one is a "mixed" total, which a screen shows as
 * separate subtotals and must not collapse, chart on one axis or rank by.
 *
 * No currency is ever assumed (PC-2). An amount with no currency is kept apart
 * under '' rather than being folded into a known one.
 *
 * Zero amounts never make a total mixed: unpaid shift types (Leave, CO) owe
 * nothing in any currency, so their currency column cannot split a total.
 *
 * Scoped-app constraints: ES5 only (Rhino) — no let/const, arrow functions or
 * template literals.
 *
 * Usage:
 *   var money = new ShiftPayMoney();
 *   var bag = {};
 *   money.add(bag, gr.getValue('u_currency'), gr.getValue('u_amount'));
 *   var totals = money.toList(bag, money.sharedCurrency(rules.catalogue()));
 */
ShiftPayMoney.prototype = {

  initialize: function () {},

  /** Add one amount to a running per-currency bag (a plain {}). */
  add: function (bag, currency, amount) {
    var code = currency || '';
    bag[code] = (bag[code] || 0) + (parseFloat(amount) || 0);
  },

  /**
   * The bag as [{ currency, amount }], ordered by currency code. Never empty.
   *
   * A total of nothing still needs a label. It takes the one currency its zero
   * rows were in, or `zeroCurrency` if there were no rows at all, or '' when
   * neither gives a single answer.
   *
   * @param {Object}  bag
   * @param {string=} zeroCurrency
   */
  toList: function (bag, zeroCurrency) {
    var seen = [], list = [];
    for (var code in bag) seen.push(code);
    seen.sort();

    for (var i = 0; i < seen.length; i++) {
      if (bag[seen[i]] !== 0) list.push({ currency: seen[i], amount: bag[seen[i]] });
    }
    if (list.length) return list;

    var label = '';
    if (seen.length === 1)  label = seen[0];
    else if (!seen.length)  label = zeroCurrency || '';
    return [{ currency: label, amount: 0 }];
  },

  /** Does this toList() result span more than one currency? */
  isMixed: function (list) {
    return list.length > 1;
  },

  /**
   * The one currency every catalogue row that names one agrees on, or '' when
   * the catalogue names none or several.
   *
   * @param {Array} rows  ShiftPayCalendarRules.catalogue()
   */
  sharedCurrency: function (rows) {
    var found = '';
    for (var i = 0; i < rows.length; i++) {
      var code = rows[i].currency;
      if (!code) continue;
      if (found && found !== code) return '';
      found = code;
    }
    return found;
  },

  type: 'ShiftPayMoney'
};
