const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

let cachedSchedule = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; 

const scrapeMomence = async (email, password) => {
    console.log("🚀 Booting up Cloud Puppeteer...");
    
    const browser = await puppeteer.launch({
        args: chromium.args,
        defaultViewport: chromium.defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: chromium.headless,
        ignoreHTTPSErrors: true,
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        console.log("🌐 Navigating to Momence Sign-In...");
        try {
            await page.goto('https://momence.com/sign-in', { waitUntil: 'networkidle2', timeout: 20000 });
        } catch (err) {
            console.log("Navigation interrupted by redirect, continuing...");
        }

        console.log("🔑 Entering credentials...");
        await page.waitForSelector('input[type="email"], input', { timeout: 10000 });
        
        const emailInput = await page.$('input[type="email"], input');
        const passwordInput = await page.$('input[type="password"]');

        await emailInput.type(email, { delay: 10 });
        await passwordInput.type(password, { delay: 10 });

        console.log("🖱️ Submitting login form...");
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {}),
            page.keyboard.press('Enter')
        ]);

        console.log("⏳ Waiting for user dashboard to load...");
        await page.waitForSelector('a[href*="/u/"]', { timeout: 15000 }).catch(() => {});

        console.log("🔍 Scanning dashboard for associated studio links (/u/ paths)...");
        const studioLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const studioAnchors = links.filter(a => a.href && a.href.includes('/u/') && !a.href.includes('/dashboard') && !a.href.includes('/login'));
            return [...new Set(studioAnchors.map(a => a.href))];
        });

        if (studioLinks.length === 0) return [];

        const studiosToScrape = studioLinks.slice(0, 2);
        console.log(`🎯 Found ${studioLinks.length} unique studio(s). Scraping top 2 to stay under timeout limits!`);
        
        const allScrapedClasses = [];

        for (const link of studiosToScrape) {
            console.log(`\n🌐 Navigating to Studio: ${link}`);
            
            try {
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
                await page.waitForSelector('div, article, section, li, tr', { timeout: 8000 }).catch(() => {});
                await new Promise(resolve => setTimeout(resolve, 2000));

                const rawStudioTitle = link.split('/').pop().replace(/-/g, ' ');
                const formattedStudio = rawStudioTitle.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
                console.log(`🔍 Parsing classes for ${formattedStudio}...`);
                
                // --- SHARED PARSER LOGIC ---
                const scrapedClasses = await page.evaluate((formattedStudio) => {
                    const sessions = [];
                    let currentDate = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
                    
                    const elements = document.querySelectorAll('div, h1, h2, h3, h4, h5, h6, span, article, li');

                    const isDateString = (text) => {
                        const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
                        const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr', 'aug', 'sep', 'oct', 'nov', 'dec'];
                        const lowerText = text.toLowerCase();
                        return (days.some(d => lowerText.includes(d)) && months.some(m => lowerText.includes(m))) || 
                               (months.some(m => lowerText.includes(m)) && /\d{1,2}/.test(lowerText));
                    };

                    elements.forEach((el, index) => {
                        const text = el.innerText || "";
                        
                        if (text.length > 5 && text.length < 40 && isDateString(text) && el.children.length === 0) {
                            currentDate = text.trim();
                            return; 
                        }
                        
                        const timeMatches = text.match(/\d{1,2}:\d{2}\s*(AM|PM)/gi);
                        const actionMatches = text.match(/Book|Sign|Waitlist|Full/gi);

                        if (timeMatches && timeMatches.length >= 1 && actionMatches && actionMatches.length >= 1) {
                            const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
                            const extractedTime = text.match(/\d{1,2}:\d{2}\s*(AM|PM)/i)?.[0] || "Upcoming";
                            const isOnline = text.toLowerCase().includes('online') || text.toLowerCase().includes('virtual') || text.toLowerCase().includes('livestream') || text.toLowerCase().includes('zoom');
                            
                            let className = "Studio Class";
                            let instructor = "Instructor";
                            let cardDate = currentDate;

                            const validContentLines = [];
                            for (const line of lines) {
                                const lower = line.toLowerCase();
                                
                                if (isDateString(line) && line.length < 40) {
                                    cardDate = line;
                                    continue;
                                }

                                if (
                                    line.length > 2 && 
                                    lower !== "class" && 
                                    lower !== "online class" &&
                                    lower !== "virtual class" &&
                                    !lower.match(/\d{1,2}:\d{2}\s*(am|pm)/i) && 
                                    !lower.includes('book') && 
                                    !lower.includes('sign') &&
                                    !lower.includes('waitlist') &&
                                    !lower.includes('full') &&
                                    !lower.match(/^\d+\s*(min|hr)/i) &&
                                    !lower.includes('show bio') &&
                                    !lower.includes('show more')
                                ) {
                                    validContentLines.push(line);
                                }
                            }

                            if (validContentLines.length > 0) {
                                className = validContentLines[0].replace(/^(Online|Virtual|Livestream)\s*[-:]?\s*/i, '').trim();
                            }
                            if (validContentLines.length > 1) {
                                instructor = validContentLines[1].replace(/^with\s+/i, '').trim();
                            }

                            sessions.push({
                                id: `mo_studio_${index}_${Math.random().toString(36).substring(7)}`,
                                studioName: formattedStudio,
                                dateString: cardDate,
                                className: isOnline ? `(Online) ${className}` : className,
                                instructor: instructor,
                                timeString: `${cardDate} - ${extractedTime}`,
                                isOnline: isOnline
                            });
                        }
                    });

                    const uniqueSessions = [];
                    const seen = new Set();
                    for (const s of sessions) {
                        const key = `${s.className}-${s.timeString}-${s.studioName}`;
                        if (!seen.has(key)) {
                            seen.add(key);
                            uniqueSessions.push(s);
                        }
                    }

                    return uniqueSessions;
                }, formattedStudio);
                // --- END SHARED PARSER LOGIC ---

                allScrapedClasses.push(...scrapedClasses);
                console.log(`✅ Extracted ${scrapedClasses.length} classes from ${formattedStudio}`);
                
            } catch (err) {
                console.error(`❌ Error scraping ${link}:`, err.message);
            }
        }

        console.log(`✨ Successfully scraped a total of ${allScrapedClasses.length} classes!`);
        return allScrapedClasses;

    } catch (error) {
        console.error("❌ Fatal Scraping Error:", error);
        throw error; 
    } finally {
        await browser.close();
    }
};

module.exports.handler = async (event) => {
    console.log("Received request from Android App!");
    
    const headers = event.headers || {};
    const moEmail = headers['x-momence-user'];
    const moPassword = headers['x-momence-password']; 

    if (!moEmail || !moPassword || moEmail === 'none' || moPassword === 'none') {
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify([]) };
    }

    if (cachedSchedule && (Date.now() - cacheTimestamp) < CACHE_TTL_MS) {
        console.log("⚡ Returning schedule from Lambda Cache!");
        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(cachedSchedule) };
    }

    try {
        console.log("Cache missed or expired. Scraping fresh data...");
        const momenceClasses = await scrapeMomence(moEmail, moPassword);

        if (momenceClasses.length > 0) {
            cachedSchedule = momenceClasses;
            cacheTimestamp = Date.now();
        }

        return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(momenceClasses) };
    } catch (error) {
        console.error("Handler error:", error);
        if (cachedSchedule) return { statusCode: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(cachedSchedule) };
        return { statusCode: 500, body: JSON.stringify({ message: "Cloud Scraper Failed: " + error.message }) };
    }
};