import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Initialize client
const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async ({ req, res, log, error }) => {
    try {
        log('Starting optimized AI career matching...');
        
        const { talentId, careerStage, responses } = JSON.parse(req.body);

        if (!talentId || !careerStage || !responses) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters: talentId, careerStage, and responses' 
            }, 400);
        }

        log(`Processing career matching for talent: ${talentId}, stage: ${careerStage}`);

        // Fetch talent details first
        const talentQuery = await databases.listDocuments(
            'career4me',
            'talents',
            [Query.equal('talentId', talentId)]
        );

        if (talentQuery.documents.length === 0) {
            return res.json({ success: false, error: 'Talent not found' }, 404);
        }

        const talent = talentQuery.documents[0];

        // Pre-filter career paths based on basic criteria to reduce dataset
        const careerPathsQuery = await databases.listDocuments(
            'career4me',
            'careerPaths',
            [Query.limit(100)] // Reduced limit for faster processing
        );

        if (careerPathsQuery.documents.length === 0) {
            return res.json({ success: false, error: 'No career paths available' }, 404);
        }

        // Pre-filter careers based on basic matching criteria
        const filteredCareers = preFilterCareers(careerPathsQuery.documents, responses, talent);
        
        log(`Pre-filtered to ${filteredCareers.length} careers from ${careerPathsQuery.documents.length} total`);

        // Generate AI-powered career matches with optimized approach
        const matches = await generateOptimizedAIMatches(
            talent,
            careerStage,
            responses,
            filteredCareers,
            log
        );

        log(`Career matching completed successfully with ${matches.length} matches`);
        return res.json({
            success: true,
            matches: matches,
            totalPaths: careerPathsQuery.documents.length,
            matchedPaths: matches.length,
            careerStage: careerStage
        });

    } catch (err) {
        error('Career matching failed:', err);
        return res.json({ 
            success: false, 
            error: err.message || 'Failed to generate career matches',
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        }, 500);
    }
};

// Pre-filter careers to reduce AI processing load
function preFilterCareers(careerPaths, responses, talent) {
    return careerPaths.filter(path => {
        // Basic filtering logic to reduce dataset
        let score = 0;
        
        // Education level matching
        const userDegrees = responses.degrees || talent.degrees || [];
        const pathDegrees = path.suggestedDegrees || [];
        if (pathDegrees.length === 0 || userDegrees.some(degree => 
            pathDegrees.some(pathDegree => 
                pathDegree.toLowerCase().includes(degree.toLowerCase()) || 
                degree.toLowerCase().includes(pathDegree.toLowerCase())
            )
        )) {
            score += 1;
        }
        
        // Skills matching
        const userSkills = [...(responses.skills || []), ...(talent.skills || [])];
        const pathSkills = path.requiredSkills || [];
        const skillMatches = userSkills.filter(skill => 
            pathSkills.some(pathSkill => 
                pathSkill.toLowerCase().includes(skill.toLowerCase()) || 
                skill.toLowerCase().includes(pathSkill.toLowerCase())
            )
        );
        if (skillMatches.length > 0) {
            score += skillMatches.length;
        }
        
        // Interest matching
        const userInterests = responses.interests || talent.interests || [];
        const pathInterests = path.requiredInterests || [];
        const interestMatches = userInterests.filter(interest => 
            pathInterests.some(pathInterest => 
                pathInterest.toLowerCase().includes(interest.toLowerCase()) || 
                interest.toLowerCase().includes(pathInterest.toLowerCase())
            )
        );
        if (interestMatches.length > 0) {
            score += interestMatches.length;
        }
        
        // Return careers with any positive score, or top careers if too many
        return score > 0;
    }).slice(0, 50); // Limit to top 50 for AI analysis
}

async function generateOptimizedAIMatches(talent, careerStage, responses, careerPaths, log) {
    const model = genAI.getGenerativeModel({ 
        model: 'gemini-2.5-flash',
        generationConfig: {
            maxOutputTokens: 4000, // Limit output for faster processing
            temperature: 0.3, // Lower temperature for more focused responses
        }
    });

    // Build concise user profile
    const userProfile = buildConciseProfile(talent, careerStage, responses);
    
    // Create simplified career paths summary - only essential fields
    const careerSummary = careerPaths.map(path => ({
        id: path.$id,
        title: path.title,
        industry: path.industry,
        skills: (path.requiredSkills || []).slice(0, 5), // Limit to top 5 skills
        interests: (path.requiredInterests || []).slice(0, 3),
        degrees: (path.suggestedDegrees || []).slice(0, 3),
        salary: `${path.minSalary || 0}-${path.maxSalary || 0}`,
        outlook: path.jobOutlook || '',
        description: (path.description || '').substring(0, 200) // Truncate long descriptions
    }));

    const optimizedPrompt = `USER PROFILE:
${userProfile}

CAREER OPTIONS (${careerSummary.length} paths):
${JSON.stringify(careerSummary, null, 1)}

TASK: Analyze user profile and return exactly 5 best career matches. Focus on skills alignment, interests match, and career stage fit.

RESPONSE FORMAT (JSON only, no extra text):
{
  "matches": [
    {
      "careerPathId": "path_id",
      "matchScore": 85,
      "reasoning": "Brief explanation focusing on key alignments between user profile and career requirements.",
      "strengths": ["Your [skill] aligns with [requirement]", "Your interest in [area] matches [career aspect]"],
      "developmentAreas": ["Develop [specific skill]", "Gain experience in [area]"],
      "recommendations": ["Take [specific action]", "Consider [specific step]"]
    }
  ]
}

Keep all explanations concise but specific. Reference actual user skills/interests and career requirements.`; 

    try {
        log('Generating optimized AI analysis...');
        const startTime = Date.now();
        
        const result = await model.generateContent(optimizedPrompt);
        const aiResponse = result.response.text();
        
        const processingTime = Date.now() - startTime;
        log(`AI processing completed in ${processingTime}ms`);
        
        // Extract and parse JSON
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('AI response did not contain valid JSON');
        }
        
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        if (!analysisResult.matches || !Array.isArray(analysisResult.matches)) {
            throw new Error('AI response contains invalid matches structure');
        }
        
        // Enrich matches with full career path data
        const enrichedMatches = analysisResult.matches
            .map(match => {
                const careerPath = careerPaths.find(cp => cp.$id === match.careerPathId);
                if (!careerPath) return null;
                
                return {
                    ...match,
                    careerPath: {
                        id: careerPath.$id,
                        title: careerPath.title,
                        industry: careerPath.industry,
                        description: careerPath.description || '',
                        minSalary: careerPath.minSalary || 0,
                        maxSalary: careerPath.maxSalary || 0,
                        jobOutlook: careerPath.jobOutlook || '',
                        requiredSkills: careerPath.requiredSkills || [],
                        suggestedDegrees: careerPath.suggestedDegrees || [],
                        dayToDayResponsibilities: careerPath.dayToDayResponsibilities || '',
                        careerProgression: careerPath.careerProgression || '',
                        toolsAndTechnologies: careerPath.toolsAndTechnologies || [],
                        typicalEmployers: careerPath.typicalEmployers || []
                    }
                };
            })
            .filter(match => match !== null);
            
        log(`Successfully processed ${enrichedMatches.length} career matches`);
        return enrichedMatches;
        
    } catch (err) {
        log(`AI generation failed: ${err.message}`);
        throw new Error(`Failed to generate AI career matches: ${err.message}`);
    }
}

function buildConciseProfile(talent, careerStage, responses) {
    // Build a much more concise user profile to reduce token usage
    const profile = {
        stage: careerStage,
        education: responses.educationLevel || talent.educationLevel || 'Not specified',
        degrees: (responses.degrees || talent.degrees || []).join(', ') || 'Not specified',
        skills: [...(responses.skills || []), ...(talent.skills || [])].join(', ') || 'Not specified',
        interests: (responses.interests || talent.interests || []).join(', ') || 'Not specified',
        targetFields: (responses.interestedFields || talent.interestedFields || []).join(', ') || 'Not specified',
        workEnv: (responses.preferredWorkEnvironment || []).join(', ') || 'Not specified'
    };

    // Add stage-specific info concisely
    if (careerStage === 'Trailblazer' && responses.currentPosition) {
        profile.current = `${responses.currentPosition} (${responses.yearsExperience || 'unknown'} years)`;
        profile.goals = (responses.careerGoals || []).join(', ');
    }

    if (careerStage === 'Horizon Changer' && responses.currentField) {
        profile.currentField = responses.currentField;
        profile.changeReasons = (responses.changeReasons || []).join(', ');
        profile.targets = (responses.targetFields || []).join(', ');
    }

    // Additional context (truncated)
    if (responses.additionalContext) {
        profile.context = responses.additionalContext.substring(0, 150);
    }

    return JSON.stringify(profile, null, 1);
}