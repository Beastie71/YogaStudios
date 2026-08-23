import puppeteer from 'puppeteer';
import fs from 'fs';
import 'dotenv/config';

const MOMENCE_EMAIL = process.env.MOMENCE_EMAIL;
const MOMENCE_PASSWORD = process.env.MOMENCE_PASSWORD;

// --- ROBUST DEBUGGING UTILITY ---
async function debugCrash(page, stepName, error) {
    console.log(`\n--- 🚨 CRASH AT STEP: ${stepName} ---`);
    console.log(`ERROR MESSAGE: ${error.message}`);
    
    if (page) {
        try {
            console.log(`CURRENT URL: ${page.url()}`);
            const safeName = stepName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            
            await page.screenshot({ path: `debug_${safeName}.png`, fullPage: true });
            console.log(`📸 Saved screenshot to: debug_${safeName}.png`);
            
            const html = await page.content();
            fs.writeFileSync(`debug_${safeName}.html`, html);
            console.log(`📄 Saved HTML DOM to: debug_${safeName}.html`);
        } catch (debugErr) {
            console.error("⚠️ Failed to generate debug files:", debugErr.message);
        }
    }
    console.log(`------------------------------------\n`);
    process.exit(1);
}

async function scrapeMomenceSchedule() {
    if (!MOMENCE_EMAIL || !MOMENCE_PASSWORD) {
        console.error("ERROR: Please provide MOMENCE_EMAIL and MOMENCE_PASSWORD in a .env file.");
        process.exit(1);
    }

    console.log(`🚀 Booting up Local Puppeteer (Linux Safe Mode)...`);
    
    const browser = await puppeteer.launch({ 
        headless: false, 
        defaultViewport: null, 
        args: [
            '--start-maximized',
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ] 
    });

    let page;

    try {
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        console.log("🌐 Navigating to Momence Sign-In...");
        try {
            await page.goto('https://momence.com/sign-in', { waitUntil: 'networkidle2', timeout: 30000 });
        } catch (err) {
            console.log(`⚠️ Navigation aborted by redirect. Waiting for inputs anyway...`);
        }

        console.log("🔑 Entering credentials...");
        try {
            await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
        } catch (err) {
            await debugCrash(page, "Login_Input_Wait", err);
        }
        
        const emailInput = await page.$('input[type="email"], input[name="email"]');
        const passwordInput = await page.$('input[type="password"], input[name="password"]');

        await emailInput.type(MOMENCE_EMAIL, { delay: 50 });
        await passwordInput.type(MOMENCE_PASSWORD, { delay: 50 });

        console.log("🖱️ Submitting login form...");
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {}),
            page.keyboard.press('Enter')
        ]);

        console.log("⏳ Waiting for user dashboard to load...");
        try {
            await page.waitForSelector('a[href*="/u/"]', { timeout: 15000 });
        } catch (err) {
            await debugCrash(page, "Dashboard_Studio_Links", err);
        }

        const studioLinks = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const studioAnchors = links.filter(a => a.href && a.href.includes('/u/') && !a.href.includes('/dashboard') && !a.href.includes('/login'));
            return [...new Set(studioAnchors.map(a => a.href))];
        });

        if (studioLinks.length === 0) {
            console.log("⚠️ No studio links found. Exiting.");
            process.exit(1);
        }

        console.log(`🎯 Found ${studioLinks.length} studios. Scraping locally...`);
        const allScrapedClasses = [];

        for (const link of studioLinks) {
            console.log(`\n🌐 Navigating to Studio: ${link}`);
            
            try {
                await page.goto(link, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
                
                await page.waitForSelector('div, article, section, li, tr', { timeout: 8000 }).catch(() => {});
                await new Promise(resolve => setTimeout(resolve, 2000)); 

                const rawStudioTitle = link.split('/').pop().replace(/-/g, ' ');
                const formattedStudio = rawStudioTitle.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

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
                        
                        // Catch Date Headers
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

                            // Filter out junk lines to find the true title and instructor
                            const validContentLines = [];
                            for (const line of lines) {
                                const lower = line.toLowerCase();
                                
                                // Some cards embed the date directly in the text body
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
                                    !lower.match(/^\d+\s*(min|hr)/i) && // filter "90 min"
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
                console.log(`❌ Soft Error scraping ${link}: ${err.message}. Continuing...`);
            }
        }

        console.log(`\n✨ Successfully scraped ${allScrapedClasses.length} total classes!`);
        console.log(JSON.stringify(allScrapedClasses, null, 2));

    } catch (error) {
        await debugCrash(page, "Fatal_Execution", error);
    } finally {
        if (browser) await browser.close();
    }
}

scrapeMomenceSchedule();