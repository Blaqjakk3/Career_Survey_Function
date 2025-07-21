import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async ({ req, res, log, error }) => {
    try {
        log('Starting AI career matching...');
        
        // Set async execution to avoid timeout
        res.setHeader('Content-Type', 'application/json');
        
        const requestBody = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
        const { talentId, careerStage, responses } = requestBody;

        if (!talentId || !careerStage || !responses) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters' 
            }, 400);
        }

        log(`Processing career matching for talent: ${talentId}, stage: ${careerStage}`);

        // Fetch all available career paths with optimized query
        const careerPaths = await databases.listDocuments(
            'career4me',
            'careerPaths',
            [
                Query.limit(50), // Reduce to 50 for faster processing
                Query.select([
                    '$id', 'title', 'industry', 'requiredSkills', 'requiredInterests', 
                    'requiredCertifications', 'suggestedDegrees', 'minSalary', 'maxSalary',
                    'description', 'required_background', 'time_to_complete'
                ])
            ]
        );

        if (careerPaths.documents.length === 0) {
            return res.json({ success: false, error: 'No career paths available' }, 404);
        }

        // Process asynchronously to avoid timeout
        setTimeout(async () => {
            try {
                const matches = await generateOptimizedAICareerMatches(
                    talentId,
                    careerStage,
                    responses,
                    careerPaths.documents,
                    log
                );
                
                log(`Successfully generated ${matches.length} career matches`);
                
            } catch (asyncError) {
                error('Async career matching failed:', asyncError);
            }
        }, 0);

        // Return immediate response to avoid timeout
        return res.json({
            success: true,
            message: 'Career matching initiated',
            status: 'processing'
        });

    } catch (err) {
        error('Career matching initialization failed:', err);
        return res.json({ 
            success: false, 
            error: err.message || 'Failed to initialize career matching'
        }, 500);
    }
};

async function generateOptimizedAICareerMatches(talentId, careerStage, responses, careerPaths, log) {
    try {
        const model = genAI.getGenerativeModel({ 
            model: 'gemini-2.5-flash',
            generationConfig: {
                temperature: 0.7,
                topP: 0.8,
                maxOutputTokens: 2048,
            }
        });

        // Create concise prompt for faster processing
        const prompt = buildOptimizedPrompt(careerStage, responses, careerPaths);
        
        log('Generating AI analysis with optimized prompt...');
        
        const result = await Promise.race([
            model.generateContent(prompt),
            new Promise((_, reject) => 
                setTimeout(() => reject(new Error('AI request timeout')), 25000)
            )
        ]);
        
        const aiResponse = result.response.text();
        log('AI response received, parsing...');
        
        // Parse AI response
        let matches;
        try {
            const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
            if (jsonMatch) {
                matches = JSON.parse(jsonMatch[0]);
            } else {
                throw new Error('No JSON array found in response');
            }
        } catch (parseError) {
            log('AI parsing failed, using fallback matching');
            matches = generateFallbackMatches(responses, careerPaths, careerStage);
        }
        
        // Enrich matches with career path data
        const enrichedMatches = matches.map(match => {
            const careerPath = careerPaths.find(path => path.$id === match.pathId);
            return careerPath ? {
                careerPath,
                matchScore: Math.min(Math.max(match.score || 0, 0), 100),
                reasoning: match.reasoning || 'Good match based on your profile',
                strengths: match.strengths || ['Your skills align well with this path'],
                developmentAreas: match.developmentAreas || ['Continue building relevant skills'],
                recommendations: match.recommendations || ['Research this field further']
            } : null;
        }).filter(Boolean);

        return enrichedMatches
            .sort((a, b) => b.matchScore - a.matchScore)
            .slice(0, 5);

    } catch (err) {
        log('AI analysis completely failed, using fallback');
        return generateFallbackMatches(responses, careerPaths, careerStage);
    }
}

function buildOptimizedPrompt(careerStage, responses, careerPaths) {
    // Build concise user profile
    let profile = `User (${careerStage}): `;
    profile += `Education: ${responses.educationLevel}`;
    if (responses.degreeProgram) profile += ` (${responses.degreeProgram})`;
    profile += `, Skills: ${responses.currentSkills?.join(', ') || 'None'}`;
    profile += `, Interests: ${responses.interests?.join(', ') || 'None'}`;
    profile += `, Fields: ${responses.interestedFields?.join(', ') || 'None'}`;

    // Add stage-specific context
    if (careerStage === 'Trailblazer') {
        profile += `, Current: ${responses.currentPath || 'Unknown'}`;
        profile += `, Experience: ${responses.yearsOfExperience || 'Unknown'}`;
        profile += `, Level: ${responses.currentSeniorityLevel || 'Unknown'}`;
    } else if (careerStage === 'Horizon Changer') {
        profile += `, Current: ${responses.currentPath || 'Unknown'}`;
        profile += `, Reason: ${responses.reasonForChange || 'Career change'}`;
        profile += `, Urgency: ${responses.changeUrgency || 'Planning'}`;
    }

    // Create compact career paths list
    const pathsSummary = careerPaths.slice(0, 30).map(path => 
        `${path.$id}:${path.title}(${path.industry})-Skills:${(path.requiredSkills || []).join(',')||'None'}`
    ).join('|');

    return `${profile}

Paths: ${pathsSummary}

Return JSON array of top 5 matches:
[{"pathId":"id","score":85,"reasoning":"brief reason","strengths":["strength1"],"developmentAreas":["area1"],"recommendations":["rec1"]}]

Focus on ${careerStage === 'Pathfinder' ? 'entry-level opportunities' : 
careerStage === 'Trailblazer' ? 'growth and advancement' : 'career transition feasibility'}`;
}

function generateFallbackMatches(responses, careerPaths, careerStage) {
    log('Using fallback matching algorithm');
    
    return careerPaths.map(path => {
        let score = 30; // Base score
        
        // Skills matching (40 points max)
        const userSkills = responses.currentSkills || [];
        const pathSkills = path.requiredSkills || [];
        const skillMatches = pathSkills.filter(skill => 
            userSkills.some(userSkill => 
                userSkill.toLowerCase().includes(skill.toLowerCase()) ||
                skill.toLowerCase().includes(userSkill.toLowerCase())
            )
        ).length;
        score += Math.min(skillMatches * 8, 40);
        
        // Interest matching (20 points max)
        const userInterests = responses.interests || [];
        const pathInterests = path.requiredInterests || [];
        const interestMatches = pathInterests.filter(interest => 
            userInterests.some(userInterest => 
                userInterest.toLowerCase().includes(interest.toLowerCase())
            )
        ).length;
        score += Math.min(interestMatches * 10, 20);
        
        // Field matching (10 points)
        const userFields = responses.interestedFields || [];
        if (userFields.some(field => 
            field.toLowerCase() === path.industry?.toLowerCase()
        )) {
            score += 10;
        }
        
        // Career stage bonus
        const background = path.required_background?.toLowerCase() || '';
        if (careerStage === 'Pathfinder' && background.includes('entry')) {
            score += 5;
        } else if (careerStage === 'Trailblazer' && background.includes('mid')) {
            score += 5;
        } else if (careerStage === 'Horizon Changer' && background.includes('experienced')) {
            score += 5;
        }
        
        return {
            pathId: path.$id,
            score: Math.min(score, 100),
            reasoning: `Matches your ${userSkills.length ? 'skills and ' : ''}interests in ${path.industry}`,
            strengths: userSkills.slice(0, 2).map(skill => `Experience with ${skill}`),
            developmentAreas: ['Build industry-specific knowledge', 'Develop key technical skills'],
            recommendations: ['Take relevant courses', 'Build a portfolio', 'Network in the industry']
        };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}