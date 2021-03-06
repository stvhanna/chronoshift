/*
 * Copyright 2014-2015 Metamarkets Group Inc.
 * Copyright 2015-2016 Imply Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Class, Instance } from 'immutable-class';
import { Timezone } from '../timezone/timezone';
import { shifters, second } from '../floor-shift-ceil/floor-shift-ceil'

let spansWithWeek = ["year", "month", "week", "day", "hour", "minute", "second"];
let spansWithoutWeek = ["year", "month", "day", "hour", "minute", "second"];

export interface DurationValue {
  year?: number;
  month?: number;
  week?: number;
  day?: number;
  hour?: number;
  minute?: number;
  second?: number;

  // Indexable
  [span: string]: number | undefined;
}

function capitalizeFirst(str: string): string {
  if (!str.length) return str;
  return str[0].toUpperCase() + str.substr(1);
}

let periodWeekRegExp = /^P(\d+)W$/;
let periodRegExp = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
//                   P   (year ) (month   ) (day     )    T(hour    ) (minute  ) (second  )
function getSpansFromString(durationStr: string): DurationValue {
  let spans: DurationValue = {};
  let matches: RegExpExecArray | null;
  if (matches = periodWeekRegExp.exec(durationStr)) {
    spans.week = Number(matches[1]);
    if (!spans.week) throw new Error("Duration can not be empty");
  } else if (matches = periodRegExp.exec(durationStr)) {
    let nums = matches.map(Number);
    for (let i = 0; i < spansWithoutWeek.length; i++) {
      let span = spansWithoutWeek[i];
      let value = nums[i + 1];
      if (value) spans[span] = value;
    }
  } else {
    throw new Error("Can not parse duration '" + durationStr + "'");
  }
  return spans;
}

function getSpansFromStartEnd(start: Date, end: Date, timezone: Timezone): DurationValue {
  start = second.floor(start, timezone);
  end = second.floor(end, timezone);
  if (end <= start) throw new Error("start must come before end");

  let spans: DurationValue = {};
  let iterator: Date = start;
  for (let i = 0; i < spansWithoutWeek.length; i++) {
    let span = spansWithoutWeek[i];
    let spanCount = 0;

    // Shortcut
    let length = end.valueOf() - iterator.valueOf();
    let canonicalLength: number = shifters[span].canonicalLength;
    if (length < canonicalLength / 4) continue;
    let numberToFit = Math.min(0, Math.floor(length / canonicalLength) - 1);
    let iteratorMove: Date;
    if (numberToFit > 0) {
      // try to skip by numberToFit
      iteratorMove = shifters[span].shift(iterator, timezone, numberToFit);
      if (iteratorMove <= end) {
        spanCount += numberToFit;
        iterator = iteratorMove;
      }
    }

    while (true) {
      iteratorMove = shifters[span].shift(iterator, timezone, 1);
      if (iteratorMove <= end) {
        iterator = iteratorMove;
        spanCount++;
      } else {
        break;
      }
    }

    if (spanCount) {
      spans[span] = spanCount;
    }
  }
  return spans;
}

function removeZeros(spans: DurationValue): DurationValue {
  let newSpans: DurationValue = {};
  for (let i = 0; i < spansWithWeek.length; i++) {
    let span = spansWithWeek[i];
    if (spans[span] > 0) {
      newSpans[span] = spans[span];
    }
  }
  return newSpans;
}

/**
 * Represents an ISO duration like P1DT3H
 */
let check: Class<DurationValue, string>;
export class Duration implements Instance<DurationValue, string> {
  public singleSpan: string;
  public spans: DurationValue;

  static fromJS(durationStr: string): Duration {
    if (typeof durationStr !== 'string') throw new TypeError("Duration JS must be a string");
    return new Duration(getSpansFromString(durationStr));
  }

  static fromCanonicalLength(length: number): Duration {
    let spans: any = {};

    for (let i = 0; i < spansWithWeek.length; i++) {
      let span = spansWithWeek[i];
      let spanLength = shifters[span].canonicalLength;
      let count = Math.floor(length / spanLength);

      length -= spanLength * count;

      spans[span] = count;
    }

    return new Duration(spans);
  }

  static isDuration(candidate: any): boolean {
    return candidate instanceof Duration;
  }

  /**
   * Constructs an ISO duration like P1DT3H from a string
   */
  constructor(spans: DurationValue);
  constructor(start: Date, end: Date, timezone: Timezone);
  constructor(spans: any, end?: Date, timezone?: Timezone) {
    if (spans && end && timezone) {
      spans = getSpansFromStartEnd(spans, end, timezone);
    } else if (typeof spans === 'object') {
      spans = removeZeros(spans);
    } else {
      throw new Error("new Duration called with bad argument");
    }

    let usedSpans = Object.keys(spans);
    if (!usedSpans.length) throw new Error("Duration can not be empty");
    if (usedSpans.length === 1) {
      this.singleSpan = usedSpans[0];
    } else if (spans.week) {
      throw new Error("Can not mix 'week' and other spans");
    }
    this.spans = spans;
  }

  public toString() {
    let strArr: string[] = ["P"];
    let spans = this.spans;
    if (spans.week) {
      strArr.push(String(spans.week), 'W');
    } else {
      let addedT = false;
      for (let i = 0; i < spansWithoutWeek.length; i++) {
        let span = spansWithoutWeek[i];
        let value = spans[span];
        if (!value) continue;
        if (!addedT && i >= 3) {
          strArr.push("T");
          addedT = true;
        }
        strArr.push(String(value), span[0].toUpperCase());
      }
    }
    return strArr.join("");
  }

  public add(duration: Duration): Duration {
    return Duration.fromCanonicalLength(
      this.getCanonicalLength() + duration.getCanonicalLength()
    );
  }

  public subtract(duration: Duration): Duration {
    let newCanonicalDuration = this.getCanonicalLength() - duration.getCanonicalLength();
    if (newCanonicalDuration < 0) throw new Error("A duration can not be negative.");
    return Duration.fromCanonicalLength(newCanonicalDuration);
  }

  public valueOf() {
    return this.spans;
  }

  public toJS() {
    return this.toString();
  }

  public toJSON() {
    return this.toString();
  }

  public equals(other: Duration): boolean {
    return Boolean(other) &&
      this.toString() === other.toString();
  }

  public isSimple(): boolean {
    let { singleSpan } = this;
    if (!singleSpan) return false;
    return this.spans[singleSpan] === 1;
  }

  public isFloorable(): boolean {
    let { singleSpan } = this;
    if (!singleSpan) return false;
    let span = this.spans[singleSpan];
    if (span === 1) return true;
    let { siblings } = shifters[singleSpan];
    if (!siblings) return false;
    return siblings % span === 0;
  }

  /**
   * Floors the date according to this duration.
   * @param date The date to floor
   * @param timezone The timezone within which to floor
   */
  public floor(date: Date, timezone: Timezone): Date {
    let { singleSpan } = this;
    if (!singleSpan) throw new Error("Can not floor on a complex duration");
    let span = this.spans[singleSpan]!;
    let mover = shifters[singleSpan]!;
    let dt = mover.floor(date, timezone);
    if (span !== 1) {
      if (!mover.siblings) throw new Error(`Can not floor on a ${singleSpan} duration that is not 1`);
      if (mover.siblings % span !== 0) throw new Error(`Can not floor on a ${singleSpan} duration that does not divide into ${mover.siblings}`);
      dt = (mover as any).round(dt, span, timezone); // the 'as any' is a TS2.0 bug, it should not be needed
    }
    return dt;
  }

  /**
   * Moves the given date by 'step' times of the duration
   * Negative step value will move back in time.
   * @param date The date to move
   * @param timezone The timezone within which to make the move
   * @param step The number of times to step by the duration
   */
  public shift(date: Date, timezone: Timezone, step: number = 1): Date {
    let spans = this.spans;
    for (let span of spansWithWeek) {
      let value = spans[span];
      if (value) date = shifters[span].shift(date, timezone, step * value);
    }
    return date;
  }

  /**
   * Materializes all the values of this duration form start to end
   * @param start The date to start on
   * @param end The date to start on
   * @param timezone The timezone within which to materialize
   * @param step The number of times to step by the duration
   */
  public materialize(start: Date, end: Date, timezone: Timezone, step: number = 1): Date[] {
    let values: Date[] = [];
    let iter = this.floor(start, timezone);
    while (iter <= end) {
      values.push(iter);
      iter = this.shift(iter, timezone, step);
    }
    return values;
  }

  /**
   * Checks to see if date is aligned to this duration within the timezone (floors to itself)
   * @param date The date to check
   * @param timezone The timezone within which to make the check
   */
  public isAligned(date: Date, timezone: Timezone): boolean {
    return this.floor(date, timezone).valueOf() === date.valueOf();
  }

  /**
   * Check to see if this duration can be divided by the given duration
   * @param smaller The smaller duration to divide by
   */
  public dividesBy(smaller: Duration): boolean {
    let myCanonicalLength = this.getCanonicalLength();
    let smallerCanonicalLength = smaller.getCanonicalLength();
    return myCanonicalLength % smallerCanonicalLength === 0 && this.isFloorable() && smaller.isFloorable();
  }

  public getCanonicalLength(): number {
    let spans = this.spans;
    let length = 0;
    for (let span of spansWithWeek) {
      let value = spans[span];
      if (value) length += value * shifters[span].canonicalLength;
    }
    return length;
  }

  public getDescription(capitalize?: boolean): string {
    let spans = this.spans;
    let description: string[] = [];
    for (let span of spansWithWeek) {
      let value = spans[span];
      let spanTitle = capitalize ? capitalizeFirst(span) : span;
      if (value) {
        if (value === 1) {
          description.push(spanTitle);
        } else {
          description.push(String(value) + ' ' + spanTitle + 's');
        }
      }
    }
    return description.join(', ');
  }

  public getSingleSpan(): string | null {
    return this.singleSpan || null;
  }

  public getSingleSpanValue(): number | null {
    if (!this.singleSpan) return null;
    return this.spans[this.singleSpan] || null;
  }

}
check = Duration;

