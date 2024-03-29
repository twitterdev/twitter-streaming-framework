import {Converseon, ConverseonSentiment} from "./converseon";
import {getLatestCoinToUSDRate} from "./coins";
import * as config from "./config";
import {StreamedTweet} from "../../twitter";

export type TweetStored = {
    id: string;
    followers_count: number;
}

export type TwitterRank = {
    score: string
    scoreByFollowers: string
    sentiment: {
        positive: number
        neutral: number
        negative: number
    }
    sentimentByFollowers: {
        positive: number
        neutral: number
        negative: number
        totalFollowers: number
    }
}

export type Entry = {
    timeMs: number
    coin: string
    tweetIds: Array<string>
    usdRate: number
}

export type Result = Entry & TwitterRank

export type ResultMapped = Entry & TwitterRank & { tweetCount: number }

export const COIN_REGEX_STR = '[a-z]+'
export const COIN_REGEX = new RegExp(`^${COIN_REGEX_STR}$`)
export const URL_REGEX =        new RegExp(`^\/(${COIN_REGEX_STR})\/(\\d+)(\/(\\d+))?\/?$`)
export const URL_LATEST_REGEX = new RegExp(`^\/(${COIN_REGEX_STR})\/latest(\/(\\d+))?\/?$`)

export const FIVE_MIN_MS = 1000 * 60 * 5
export const ONE_WEEK_MS = 1000 * 60 * 60 * 24 * 7 + FIVE_MIN_MS
export const ONE_HOUR_MS = 1000 * 60 * 60

export const scoreOptions = ['positive', 'neutral', 'negative']

const converseon = new Converseon(config.CONVERSEON_API_KEY)

export function computeTwitterRank(tweets: Array<TweetStored>, sentiments: Array<ConverseonSentiment>): TwitterRank {
    const defaultValue = {sentiment: {positive: 0, neutral: 0, negative: 0}, sentimentByFollowers: {positive: 0, neutral: 0, negative: 0, totalFollowers: 0}}
    if (!tweets || tweets.length === 0) {
        return {score: 'neutral', scoreByFollowers: 'neutral', ...defaultValue}
    }
    const ranks = tweets.reduce(({sentiment, sentimentByFollowers}, {followers_count}, idx) => {

        const tweetSentiment = sentiments[idx]
        const value = tweetSentiment?.value || 'neutral'

        return {
            sentiment:{
                ...sentiment,
                [value]: sentiment[value] + 1,
            },
            sentimentByFollowers: {
                ...sentimentByFollowers,
                [value]: sentimentByFollowers[value] + followers_count,
                totalFollowers: sentimentByFollowers.totalFollowers + followers_count,
            }
        }
    }, defaultValue)

    // @ts-ignore
    const maxRank = (rankType: 'sentiment' | 'sentimentByFollowers') => (max: string, v: string) => ranks[rankType][max] > ranks[rankType][v] ? max : v
    const score = scoreOptions.reduce(maxRank('sentiment'))
    const scoreByFollowers = scoreOptions.reduce(maxRank('sentimentByFollowers'))

    return {
        ...ranks,
        score,
        scoreByFollowers
    }
}

export async function getDataToStore(streamedTweets: StreamedTweet[], coin = 'bitcoin') {
    const timeMs = new Date().getTime();
    const [usdRate, sentiments] = await Promise.all([
        getLatestCoinToUSDRate(coin),
        converseon.sentiment(streamedTweets.map(tweet => tweet.text)),
    ])
    const tweets = streamedTweets.map(({id, full: {user: {followers_count}}}, idx) => ({id, followers_count}))
    const tweetIds = tweets.sort(
        (a, b) => b.followers_count - a.followers_count)
        .map(({id}) => id)
    const twitterRank = computeTwitterRank(tweets, sentiments)
    return { timeMs, coin, ...twitterRank, tweetIds, usdRate }
}

export function getDatapointFrequency(startTimestamp: number, endTimestamp: number) {
    const diff = endTimestamp - startTimestamp;
    if (diff <= ONE_HOUR_MS) {
        return 1
    } else if (diff <= ONE_HOUR_MS * 2) {
        return 2
    } else if (diff <= ONE_HOUR_MS * 4) {
        return 3
    } else if (diff <= ONE_HOUR_MS * 24) {
        return 10
    } else if (diff <= ONE_HOUR_MS * 24 * 2) {
        return 15
    } else {
        return 30
    }
}

const TWEET_ID_SAMPLE_SIZE = 5

function getTweetResultMapped(result?: Result) {
    if (!result) {
        return result
    }
    const tweetIds = result.tweetIds || []
    return {
        ...result,
        tweetCount: tweetIds.length,
        tweetIds: tweetIds.slice(0, TWEET_ID_SAMPLE_SIZE)
    }
}

export function getCombinedResultAveraged(resultA?: ResultMapped, resultB?: ResultMapped, frequency = 1) {
    if (!resultA && resultB) {
        return resultB
    }
    if (resultA && !resultB) {
        return resultA
    }
    if (resultA && resultB) {
        return {
            ...resultA,
            tweetCount: Math.round((resultA.tweetCount + resultB.tweetCount) / frequency),
            tweetIds: [...resultA.tweetIds, ...resultB.tweetIds],
            sentiment: {
                neutral: Math.round((resultA.sentiment.neutral + resultB.sentiment.neutral) / frequency),
                positive: Math.round((resultA.sentiment.positive + resultB.sentiment.positive) / frequency),
                negative: Math.round((resultA.sentiment.neutral + resultB.sentiment.negative) / frequency),
            },
            sentimentByFollowers: {
                neutral: Math.round((resultA.sentimentByFollowers.neutral + resultB.sentimentByFollowers.neutral) / frequency),
                positive: Math.round((resultA.sentimentByFollowers.positive + resultB.sentimentByFollowers.positive) / frequency),
                negative: Math.round((resultA.sentimentByFollowers.negative + resultB.sentimentByFollowers.negative) / frequency),
                totalFollowers: Math.round((resultA.sentimentByFollowers.totalFollowers + resultB.sentimentByFollowers.totalFollowers) / frequency),
            },
        }
    }
}

export function getCombinedResults(results: Result[], dataFrequency: number) {
    let resultsCondensed: Result[] = []
    let tempCombinedResult: ResultMapped|undefined = undefined
    let counter = 0
    for (let i = results.length - 1; i >= 0; i--) {
        const currentResult = getTweetResultMapped(results[i])
        counter++
        if (counter === dataFrequency) {
            tempCombinedResult = getCombinedResultAveraged(tempCombinedResult, currentResult, dataFrequency)
            resultsCondensed = tempCombinedResult ? [tempCombinedResult,...resultsCondensed] : resultsCondensed
            tempCombinedResult = undefined
            counter = 0
        } else {
            tempCombinedResult = getCombinedResultAveraged(tempCombinedResult, currentResult)
        }
    }

    return resultsCondensed
}